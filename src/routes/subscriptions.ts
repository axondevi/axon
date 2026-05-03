/**
 * Per-agent subscription routes — owner CRUD + cron billing.
 *
 *   GET    /v1/agents/:id/subscription                → current state for one agent
 *   POST   /v1/agents/:id/subscription                → create/reactivate (body: {plan?})
 *   PATCH  /v1/agents/:id/subscription                → change plan or cancel
 *   GET    /v1/subscriptions                          → owner's full list
 *   POST   /v1/admin/cron/subscription-billing        → daily cron, x-admin-key auth
 *
 * Billing logic (in cron):
 *   1. Pick subscriptions where current_period_end <= NOW AND status='active'
 *   2. computeBillAmountMicro(plan, used_*) → total
 *   3. wallet.debit(owner, total, type='subscription_charge')
 *   4. On success: extend +30d, reset counters, log
 *   5. On insufficient funds: status='grace', grace_until=NOW+5d, send email
 *
 *   Separate sweep: subscriptions where status='grace' AND grace_until <= NOW
 *   → status='cancelled', set agents.paused_at = NOW (WhatsApp goes silent).
 */
import { Hono } from 'hono';
import { eq, and, lte, inArray } from 'drizzle-orm';
import { db } from '~/db';
import { agents, agentSubscriptions, users, wallets } from '~/db/schema';
import { Errors } from '~/lib/errors';
import { debit, getBalance, fromMicro } from '~/wallet/service';
import { PLANS, DEFAULT_PLAN, GRACE_PERIOD_DAYS, computeBillAmountMicro, type Plan } from '~/payment/plans';
import { log } from '~/lib/logger';

export const ownerSubscriptions = new Hono();
export const ownerSubscriptionsRoot = new Hono();
export const adminSubscriptionsCron = new Hono();

// Helper: ensure caller owns the agent.
async function requireOwnedAgent(userId: string, agentId: string) {
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');
  return a;
}

function thirtyDaysFromNow(): Date {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

// Serializable plan shape — strips the BigInt `price_micro` field that
// Object.values(PLANS) would otherwise leak into c.json() and trip
// "cannot serialize BigInt" runtime errors.
function serializePlans() {
  return Object.values(PLANS).map((p) => ({
    id: p.id,
    name: p.name,
    price_usd: p.price_usd,
    included: p.included,
  }));
}

function serializeSub(s: typeof agentSubscriptions.$inferSelect) {
  const plan = PLANS[s.plan as Plan['id']] ?? PLANS[DEFAULT_PLAN];
  const projected = computeBillAmountMicro({
    plan: s.plan as Plan['id'],
    used_turns: s.usedTurns,
    used_vision: s.usedVision,
    used_pdf: s.usedPdf,
    used_reminders: s.usedReminders,
  });
  return {
    id: s.id,
    agent_id: s.agentId,
    plan: s.plan,
    plan_name: plan.name,
    plan_price_usd: plan.price_usd,
    status: s.status,
    current_period_start: s.currentPeriodStart,
    current_period_end: s.currentPeriodEnd,
    days_until_renewal: Math.max(
      0,
      Math.ceil((s.currentPeriodEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
    ),
    last_billed_at: s.lastBilledAt,
    last_bill_usd: Number(s.lastBillMicro) / 1_000_000,
    grace_until: s.graceUntil,
    usage: {
      turns: s.usedTurns,
      vision: s.usedVision,
      pdf: s.usedPdf,
      reminders: s.usedReminders,
    },
    included: plan.included,
    projected_next_bill_usd: Number(projected.total_micro) / 1_000_000,
    projected_breakdown: {
      base_usd: Number(projected.breakdown.base_micro) / 1_000_000,
      overage_usd: {
        turns: Number(projected.breakdown.overage.turns_micro) / 1_000_000,
        vision: Number(projected.breakdown.overage.vision_micro) / 1_000_000,
        pdf: Number(projected.breakdown.overage.pdf_micro) / 1_000_000,
        reminders: Number(projected.breakdown.overage.reminders_micro) / 1_000_000,
      },
    },
  };
}

// ─── List per-owner ────────────────────────────────────────
ownerSubscriptionsRoot.get('/subscriptions', async (c) => {
  const user = c.get('user') as { id: string };
  const rows = await db
    .select()
    .from(agentSubscriptions)
    .where(eq(agentSubscriptions.ownerId, user.id));
  return c.json({
    subscriptions: rows.map(serializeSub),
    plans: serializePlans(),
  });
});

// ─── Get one ───────────────────────────────────────────────
ownerSubscriptions.get('/:id/subscription', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  await requireOwnedAgent(user.id, agentId);

  const [sub] = await db
    .select()
    .from(agentSubscriptions)
    .where(eq(agentSubscriptions.agentId, agentId))
    .limit(1);

  if (!sub) {
    return c.json({
      subscription: null,
      plans: serializePlans(),
      message: 'No subscription yet — POST to this endpoint to activate.',
    });
  }
  return c.json({ subscription: serializeSub(sub), plans: serializePlans() });
});

// ─── Create or reactivate ──────────────────────────────────
ownerSubscriptions.post('/:id/subscription', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  const agent = await requireOwnedAgent(user.id, agentId);

  const body = await c.req.json().catch(() => ({} as any));
  const planId: Plan['id'] = body.plan === 'pro' ? 'pro' : 'starter';
  const plan = PLANS[planId];

  // Check wallet has enough for the first month — refuse early if not.
  const balance = await getBalance(user.id);
  if (BigInt(balance.balanceMicro) < plan.price_micro) {
    return c.json(
      {
        error: 'insufficient_funds',
        message: `Saldo insuficiente. Plano ${plan.name} custa $${plan.price_usd}/mês. Saldo atual: $${fromMicro(BigInt(balance.balanceMicro))}.`,
        required_usd: plan.price_usd,
        balance_usd: Number(fromMicro(BigInt(balance.balanceMicro))),
      },
      402,
    );
  }

  // Debit first month immediately.
  await debit({
    userId: user.id,
    amountMicro: plan.price_micro,
    type: 'subscription_charge',
    meta: { agent_id: agentId, plan: planId, period: 'first' },
  });

  // Upsert subscription row — reactivation path: if existed and was
  // cancelled/grace, flip back to active and reset counters + period.
  const [existing] = await db
    .select()
    .from(agentSubscriptions)
    .where(eq(agentSubscriptions.agentId, agentId))
    .limit(1);

  const periodEnd = thirtyDaysFromNow();
  let row;
  if (existing) {
    [row] = await db
      .update(agentSubscriptions)
      .set({
        plan: planId,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: periodEnd,
        lastBilledAt: new Date(),
        lastBillMicro: plan.price_micro,
        lastBillFailedAt: null,
        graceUntil: null,
        usedTurns: 0,
        usedVision: 0,
        usedPdf: 0,
        usedReminders: 0,
        updatedAt: new Date(),
      })
      .where(eq(agentSubscriptions.id, existing.id))
      .returning();
    // Unpause the agent if it was paused for billing.
    if (agent.pausedAt) {
      await db.update(agents).set({ pausedAt: null }).where(eq(agents.id, agentId));
    }
  } else {
    [row] = await db
      .insert(agentSubscriptions)
      .values({
        agentId,
        ownerId: user.id,
        plan: planId,
        status: 'active',
        currentPeriodEnd: periodEnd,
        lastBilledAt: new Date(),
        lastBillMicro: plan.price_micro,
      })
      .returning();
  }

  return c.json({ ok: true, subscription: serializeSub(row) });
});

// ─── Patch (change plan / cancel) ──────────────────────────
ownerSubscriptions.patch('/:id/subscription', async (c) => {
  const user = c.get('user') as { id: string };
  const agentId = c.req.param('id');
  await requireOwnedAgent(user.id, agentId);

  const body = await c.req.json().catch(() => ({} as any));
  const [sub] = await db
    .select()
    .from(agentSubscriptions)
    .where(eq(agentSubscriptions.agentId, agentId))
    .limit(1);
  if (!sub) throw Errors.notFound('Subscription');

  const updates: Partial<typeof agentSubscriptions.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (body.action === 'cancel') {
    updates.status = 'cancelled';
    // Pause the agent so it stops handling WhatsApp turns.
    await db.update(agents).set({ pausedAt: new Date() }).where(eq(agents.id, agentId));
  } else if (body.plan && (body.plan === 'starter' || body.plan === 'pro')) {
    // Plan change takes effect at next renewal — don't pro-rate now.
    updates.plan = body.plan;
  } else {
    return c.json({ error: 'bad_request', message: 'Provide {plan: starter|pro} or {action: cancel}' }, 400);
  }

  await db.update(agentSubscriptions).set(updates).where(eq(agentSubscriptions.id, sub.id));
  return c.json({ ok: true });
});

// ─── Cron ──────────────────────────────────────────────────
//
// Two passes per run:
//   1. Bill anyone whose period_end is in the past and status is 'active'
//      OR was 'grace' (retry with current balance).
//   2. Sweep grace expirations — flip to cancelled + pause the agent.
//
// Idempotent: re-running mid-day is safe because we set lastBilledAt
// alongside currentPeriodEnd; a row that just got billed won't reappear
// in pass 1 (its new currentPeriodEnd is +30d).
adminSubscriptionsCron.post('/cron/subscription-billing', async (c) => {
  const adminKey = c.req.header('x-admin-key');
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const now = new Date();
  const stats = { billed: 0, grace_started: 0, cancelled: 0, errors: 0 };

  // Pass 1 — try to bill due subscriptions.
  const due = await db
    .select()
    .from(agentSubscriptions)
    .where(
      and(
        lte(agentSubscriptions.currentPeriodEnd, now),
        inArray(agentSubscriptions.status, ['active', 'grace']),
      ),
    )
    .limit(500);

  for (const sub of due) {
    const planId = sub.plan as Plan['id'];
    const total = computeBillAmountMicro({
      plan: planId,
      used_turns: sub.usedTurns,
      used_vision: sub.usedVision,
      used_pdf: sub.usedPdf,
      used_reminders: sub.usedReminders,
    });
    try {
      await debit({
        userId: sub.ownerId,
        amountMicro: total.total_micro,
        type: 'subscription_charge',
        meta: {
          agent_id: sub.agentId,
          plan: planId,
          period_start: sub.currentPeriodStart.toISOString(),
          period_end: sub.currentPeriodEnd.toISOString(),
          breakdown: {
            base: Number(total.breakdown.base_micro) / 1_000_000,
            overage: {
              turns: Number(total.breakdown.overage.turns_micro) / 1_000_000,
              vision: Number(total.breakdown.overage.vision_micro) / 1_000_000,
              pdf: Number(total.breakdown.overage.pdf_micro) / 1_000_000,
              reminders: Number(total.breakdown.overage.reminders_micro) / 1_000_000,
            },
          },
        },
      });

      await db
        .update(agentSubscriptions)
        .set({
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          lastBilledAt: now,
          lastBillMicro: total.total_micro,
          lastBillFailedAt: null,
          graceUntil: null,
          usedTurns: 0,
          usedVision: 0,
          usedPdf: 0,
          usedReminders: 0,
          updatedAt: now,
        })
        .where(eq(agentSubscriptions.id, sub.id));

      // Unpause the agent if grace had paused it (defensive).
      const [agent] = await db.select().from(agents).where(eq(agents.id, sub.agentId)).limit(1);
      if (agent?.pausedAt) {
        await db.update(agents).set({ pausedAt: null }).where(eq(agents.id, sub.agentId));
      }
      stats.billed++;
    } catch (err: any) {
      // Insufficient funds (most common) — start the grace window.
      const isInsufficient = /insufficient/i.test(err?.message || '') || err?.code === 'insufficient_funds';
      if (isInsufficient) {
        if (sub.status === 'active') {
          // Just entered grace.
          await db
            .update(agentSubscriptions)
            .set({
              status: 'grace',
              lastBillFailedAt: now,
              graceUntil: new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000),
              updatedAt: now,
            })
            .where(eq(agentSubscriptions.id, sub.id));
          stats.grace_started++;
        }
        // If already grace, leave the row alone — pass 2 handles expiration.
      } else {
        log.warn('subscription_bill_error', {
          subscription_id: sub.id,
          error: err?.message || String(err),
        });
        stats.errors++;
      }
    }
  }

  // Pass 2 — expire grace.
  const expired = await db
    .select()
    .from(agentSubscriptions)
    .where(
      and(
        eq(agentSubscriptions.status, 'grace'),
        lte(agentSubscriptions.graceUntil, now),
      ),
    )
    .limit(500);

  for (const sub of expired) {
    await db
      .update(agentSubscriptions)
      .set({ status: 'cancelled', updatedAt: now })
      .where(eq(agentSubscriptions.id, sub.id));
    await db
      .update(agents)
      .set({ pausedAt: now })
      .where(eq(agents.id, sub.agentId));
    stats.cancelled++;
  }

  return c.json({ ok: true, ran_at: now.toISOString(), ...stats, due_count: due.length, expired_count: expired.length });
});
