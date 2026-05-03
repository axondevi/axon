/**
 * Admin endpoints for webhook delivery operations.
 *
 * Mounted under /v1/admin/webhooks (with adminAuth middleware in
 * src/index.ts). The user-facing webhook subscription CRUD lives in
 * routes/webhook-subs.ts; this file is for the operator inspecting
 * the delivery log + replaying failures.
 */
import { Hono } from 'hono';
import { eq, and, desc, isNull, inArray } from 'drizzle-orm';
import { db } from '~/db';
import { webhookDeliveries, webhookSubscriptions } from '~/db/schema';
import { adminAuth } from '~/auth/middleware';
import { Errors } from '~/lib/errors';
import { retryDelivery } from '~/webhooks/emitter';

const app = new Hono();

// ─── GET /v1/admin/webhooks/deliveries ────────────────
// List deliveries — defaults to failed/pending only so the operator
// has a focused queue. Add ?include=all to get the full history.
app.get('/deliveries', adminAuth, async (c) => {
  const include = c.req.query('include') ?? 'failed';
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);

  const rows = include === 'all'
    ? await db.select().from(webhookDeliveries).orderBy(desc(webhookDeliveries.createdAt)).limit(limit)
    : await db.select().from(webhookDeliveries)
        .where(isNull(webhookDeliveries.deliveredAt))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit);

  // Join subscription URLs in a single follow-up query rather than per-row
  const subIds = [...new Set(rows.map((r) => r.subscriptionId))];
  const subRows = subIds.length
    ? await db.select({ id: webhookSubscriptions.id, url: webhookSubscriptions.url, userId: webhookSubscriptions.userId, active: webhookSubscriptions.active })
        .from(webhookSubscriptions)
        .where(inArray(webhookSubscriptions.id, subIds))
    : [];
  const subMap = new Map(subRows.map((s) => [s.id, s]));

  return c.json({
    count: rows.length,
    deliveries: rows.map((r) => ({
      id: r.id,
      subscription_id: r.subscriptionId,
      subscription_url: subMap.get(r.subscriptionId)?.url ?? null,
      subscription_active: subMap.get(r.subscriptionId)?.active ?? null,
      user_id: subMap.get(r.subscriptionId)?.userId ?? null,
      event: r.event,
      attempts: r.attempts,
      last_status: r.lastStatus,
      last_error: r.lastError,
      delivered_at: r.deliveredAt,
      created_at: r.createdAt,
    })),
  });
});

// ─── POST /v1/admin/webhooks/deliveries/:id/retry ─────
// Re-attempt a single failed delivery. Inserts a NEW delivery row with
// attempts=previous+1 — original is preserved for audit.
app.post('/deliveries/:id/retry', adminAuth, async (c) => {
  const id = c.req.param('id');
  if (!id) throw Errors.badRequest('delivery id required');
  const result = await retryDelivery(id);
  // Surface 4xx if the delivery was unrecoverable (subscription deleted,
  // SSRF blocked) so cron retries can detect "stop trying this one".
  if (!result.ok && /not_found|subscription_(deleted|inactive)|url_unsafe|already_delivered/.test(result.error ?? '')) {
    return c.json(result, 400);
  }
  return c.json(result);
});

// ─── POST /v1/admin/webhooks/deliveries/retry-all-failed ──
// Bulk retry all currently-failed deliveries. Bounded to last N days
// so a backlog from years ago doesn't get accidentally replayed.
app.post('/deliveries/retry-all-failed', adminAuth, async (c) => {
  const body = await c.req.json().catch(() => ({} as { days_back?: number; limit?: number }));
  const daysBack = Math.min(body.days_back ?? 7, 30);
  const limit = Math.min(body.limit ?? 100, 500);
  const since = new Date(Date.now() - daysBack * 86400_000);

  const { gte } = await import('drizzle-orm');
  const failed = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(isNull(webhookDeliveries.deliveredAt), gte(webhookDeliveries.createdAt, since)))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);

  let succeeded = 0;
  let failed_again = 0;
  const errors: Array<{ delivery_id: string; error: string }> = [];
  for (const row of failed) {
    const r = await retryDelivery(row.id).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (r.ok) succeeded++;
    else {
      failed_again++;
      if (errors.length < 20 && r.error) errors.push({ delivery_id: row.id, error: r.error });
    }
  }
  return c.json({ attempted: failed.length, succeeded, failed_again, errors });
});

export default app;
