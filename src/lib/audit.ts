/**
 * Append-only audit logger for privileged actions.
 *
 *   await audit(c, 'admin.credit', { target_user_id: u, meta: {...} });
 *
 * Pulls actor identity from the Hono context: prefers the authed user
 * id, falls back to "admin_key" when only x-admin-key was used. Captures
 * IP, user-agent, request_id automatically. Never throws on insert
 * failure — audit MUST NOT break the calling path; we just log.warn.
 *
 * All inserts are best-effort fire-and-forget. The caller does not wait.
 */
import type { Context } from 'hono';
import { db } from '~/db';
import { adminAuditLog } from '~/db/schema';
import { log } from '~/lib/logger';

export interface AuditOpts {
  /** The user the action targets (credit recipient, policy holder, etc). */
  target_user_id?: string | null;
  /** Free-form metadata for the action — request body summary, deltas, etc. */
  meta?: Record<string, unknown>;
}

function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '';
}

/**
 * Capture an audit row. `action` is a stable dotted slug —
 * 'admin.credit', 'admin.policy.set', 'user.api_key.rotate',
 * 'user.account.delete', 'voice.clone'.
 */
export function audit(c: Context, action: string, opts: AuditOpts = {}): void {
  // Pull identity from the context. If the caller went through apiKeyAuth,
  // c.get('user') is set. If they went through adminAuth only, the
  // user context is unset → mark actor_admin_key=true.
  const user = c.get('user') as { id?: string } | undefined;
  const actorUserId = user?.id ?? null;
  const actorAdminKey = !actorUserId; // adminAuth gates with no user context

  const requestId = c.get('request_id') ?? null;
  const ip = clientIp(c) || null;
  const userAgent = (c.req.header('user-agent') ?? '').slice(0, 240) || null;

  // Fire-and-forget. Don't await; don't break the caller path.
  db.insert(adminAuditLog)
    .values({
      actorUserId,
      actorAdminKey,
      targetUserId: opts.target_user_id ?? null,
      action,
      requestId,
      ip,
      userAgent,
      meta: opts.meta ?? null,
    })
    .then(() => {})
    .catch((err) => {
      log.warn('audit_write_failed', {
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
