/**
 * Read access for the privileged-action audit log.
 *
 *   GET /v1/admin/audit?action=admin.credit&limit=100&before=<iso>
 *
 * Admin-only. Append-only on writes — there is no delete or update
 * surface. Ops uses this for compliance reviews and incident response.
 */
import { Hono } from 'hono';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '~/db';
import { adminAuditLog } from '~/db/schema';
import { adminAuth } from '~/auth/middleware';

const app = new Hono();

app.get('/', adminAuth, async (c) => {
  const action = c.req.query('action') ?? '';
  const targetUserId = c.req.query('target_user_id') ?? '';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '100', 10) || 100, 1), 500);
  const before = c.req.query('before');

  const conds: Array<ReturnType<typeof eq>> = [];
  if (action) conds.push(eq(adminAuditLog.action, action));
  if (targetUserId) conds.push(eq(adminAuditLog.targetUserId, targetUserId));
  if (before) conds.push(lt(adminAuditLog.createdAt, new Date(before)));

  const rows = await db
    .select()
    .from(adminAuditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(limit);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor_user_id: r.actorUserId,
      actor_admin_key: r.actorAdminKey,
      target_user_id: r.targetUserId,
      request_id: r.requestId,
      ip: r.ip,
      user_agent: r.userAgent,
      meta: r.meta,
      created_at: r.createdAt,
    })),
    count: rows.length,
  });
});

/**
 * Lightweight summary for the operator dashboard. Counts by action
 * over the last 7 days. Cheap aggregate.
 */
app.get('/summary', adminAuth, async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '7', 10) || 7, 1), 90);
  const rows = await db.execute(sql`
    SELECT action, COUNT(*)::int AS count, MAX(created_at) AS last_seen
    FROM admin_audit_log
    WHERE created_at >= NOW() - (${days} || ' days')::interval
    GROUP BY action
    ORDER BY count DESC
  `);
  const data = ((rows as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]) ?? []) as Array<{
    action: string;
    count: number;
    last_seen: string;
  }>;
  return c.json({ window_days: days, data });
});

export default app;
