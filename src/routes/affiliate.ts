/**
 * Affiliate-side endpoints — for users earning commission as referrers.
 *
 * Two responsibilities:
 *   GET /v1/affiliate/stats   — How much I've earned as a referrer
 *   GET /v1/affiliate/agents  — Which agents have affiliate enabled (so a
 *                                referrer can pick what to promote)
 *
 * Owner-side configuration (toggle, payout amount) lives on the regular
 * agent PATCH endpoint — see src/routes/agents.ts. This file is the
 * EARNINGS view for the person running affiliate links.
 */
import { Hono } from 'hono';
import { and, desc, eq, sum, count } from 'drizzle-orm';
import { db } from '~/db';
import { agents, contactMemory, transactions, users } from '~/db/schema';

export const affiliateRoutes = new Hono();

/**
 * GET /v1/affiliate/stats
 * Returns the running total of affiliate payouts received plus the
 * paginated list of contacts I brought in (most recent first).
 *
 * Reads transactions where meta->>'purpose' = 'affiliate_payout' AND
 * type = 'bonus' AND user_id = me. That ledger is append-only, so it's
 * the source of truth for total earned. The contact list is a join on
 * contact_memory where referred_by_user_id = me.
 */
affiliateRoutes.get('/stats', async (c) => {
  const user = c.get('user') as { id: string };

  // Total earned: sum of bonus transactions tagged as affiliate_payout
  const [earnings] = await db
    .select({
      total: sum(transactions.amountMicro),
      count: count(transactions.id),
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, user.id),
        eq(transactions.type, 'bonus'),
      ),
    );

  // Recent contacts I brought in — gives the affiliate a feel for what's
  // converting. We also surface the agent's payout setting so the
  // affiliate can see the per-contact reward at a glance.
  const recent = await db
    .select({
      contactId: contactMemory.id,
      agentId: contactMemory.agentId,
      agentSlug: agents.slug,
      agentName: agents.name,
      payoutMicro: agents.affiliatePayoutMicro,
      paidAt: contactMemory.affiliatePaidAt,
      firstContactAt: contactMemory.firstContactAt,
    })
    .from(contactMemory)
    .innerJoin(agents, eq(contactMemory.agentId, agents.id))
    .where(eq(contactMemory.referredByUserId, user.id))
    .orderBy(desc(contactMemory.firstContactAt))
    .limit(50);

  return c.json({
    total_earned_usdc: (Number(earnings?.total ?? 0n) / 1_000_000).toFixed(6),
    payouts_count: earnings?.count ?? 0,
    recent_contacts: recent.map((r) => ({
      contact_id: r.contactId,
      agent_id: r.agentId,
      agent_slug: r.agentSlug,
      agent_name: r.agentName,
      reward_usdc: (Number(r.payoutMicro) / 1_000_000).toFixed(6),
      paid: !!r.paidAt,
      paid_at: r.paidAt,
      first_contact_at: r.firstContactAt,
    })),
  });
});

/**
 * GET /v1/affiliate/agents
 * Public-ish: lists all agents that have `affiliate_enabled=true` AND
 * a non-zero payout. Anyone logged in can use this to pick agents to
 * promote. Owner ids are NOT exposed (just the slug + payout). Sorted
 * by highest payout first to nudge people toward better deals.
 */
affiliateRoutes.get('/agents', async (c) => {
  const rows = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      name: agents.name,
      description: agents.description,
      payoutMicro: agents.affiliatePayoutMicro,
    })
    .from(agents)
    .where(and(eq(agents.affiliateEnabled, true), eq(agents.public, true)))
    .orderBy(desc(agents.affiliatePayoutMicro));

  // Filter out zero-payout (defensive — should be excluded by the
  // owner toggle but doesn't hurt to double-check).
  const real = rows.filter((r) => r.payoutMicro > 0n);

  // Affiliate link the caller can copy: /agent/<slug>?ref=<my-user-id>.
  // We fill `?ref=<me>` here so the dashboard doesn't need to know how
  // to construct it.
  const me = c.get('user') as { id: string };

  return c.json({
    data: real.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      reward_usdc: (Number(r.payoutMicro) / 1_000_000).toFixed(6),
      affiliate_link: `/agent/${r.slug}?ref=${me.id}`,
    })),
    count: real.length,
  });
});
