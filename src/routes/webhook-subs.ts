/**
 * User-facing CRUD for their own outbound webhook subscriptions.
 *
 * Mounted under /v1/webhook-subscriptions — authed via x-api-key.
 */
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '~/db';
import { webhookSubscriptions, webhookDeliveries } from '~/db/schema';
import { Errors } from '~/lib/errors';

const app = new Hono();

const VALID_EVENTS = [
  'deposit.received',
  'balance.low',
  'policy.denied',
  'call.refunded',
  'rate_limit.hit',
  'wallet.reserved_exceeds_balance',
];

// ─── GET /v1/webhook-subscriptions ────────────────────
app.get('/', async (c) => {
  const user = c.get('user') as { id: string };
  const rows = await db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.userId, user.id));
  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      url: r.url,
      events: r.events,
      active: r.active,
      created_at: r.createdAt,
      // NEVER return the secret after creation
    })),
  });
});

// ─── POST /v1/webhook-subscriptions ───────────────────
app.post('/', async (c) => {
  const user = c.get('user') as { id: string };
  const body = await c.req.json<{ url: string; events: string[] }>();

  if (!body?.url || !/^https?:\/\//.test(body.url)) {
    throw Errors.badRequest('url must start with http:// or https://');
  }
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) throw Errors.badRequest('events is required');
  for (const e of events) {
    if (!VALID_EVENTS.includes(e)) {
      throw Errors.badRequest(`Unknown event '${e}'. Allowed: ${VALID_EVENTS.join(', ')}`);
    }
  }

  const secret = 'whsec_' + randomBytes(24).toString('hex');
  const [row] = await db
    .insert(webhookSubscriptions)
    .values({
      userId: user.id,
      url: body.url,
      events,
      secret,
    })
    .returning();

  return c.json({
    id: row.id,
    url: row.url,
    events: row.events,
    secret,
    warning: 'Save the secret now — it cannot be retrieved later. Used to verify HMAC signatures on incoming deliveries.',
  });
});

// ─── DELETE /v1/webhook-subscriptions/:id ─────────────
app.delete('/:id', async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  const res = await db
    .delete(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.id, id),
        eq(webhookSubscriptions.userId, user.id),
      ),
    )
    .returning({ id: webhookSubscriptions.id });
  if (res.length === 0) throw Errors.notFound('Subscription');
  return c.json({ ok: true });
});

// ─── GET /v1/webhook-subscriptions/:id/deliveries ─────
app.get('/:id/deliveries', async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  // Ownership check
  const [sub] = await db
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.id, id),
        eq(webhookSubscriptions.userId, user.id),
      ),
    )
    .limit(1);
  if (!sub) throw Errors.notFound('Subscription');

  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.subscriptionId, id))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(50);

  return c.json({ data: rows });
});

export default app;
