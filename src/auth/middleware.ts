import type { Context, Next } from 'hono';
import { eq, or, and, isNotNull, gt } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { db } from '~/db';
import { users } from '~/db/schema';
import { hashApiKey } from '~/lib/crypto';
import { Errors } from '~/lib/errors';
import { env } from '~/config';

export async function apiKeyAuth(c: Context, next: Next) {
  const header = c.req.header('x-api-key') ?? c.req.header('authorization');
  if (!header) throw Errors.unauthorized();

  const key = header.startsWith('Bearer ') ? header.slice(7) : header;
  const hash = hashApiKey(key);

  // Accept either the current hash OR the previous-rotated hash if it's
  // still inside the grace window. Single SELECT — Postgres returns at
  // most one row because hashes are unique per user.
  const now = new Date();
  const [user] = await db
    .select()
    .from(users)
    .where(
      or(
        eq(users.apiKeyHash, hash),
        and(
          eq(users.prevApiKeyHash, hash),
          isNotNull(users.prevApiKeyExpiresAt),
          gt(users.prevApiKeyExpiresAt, now),
        ),
      ),
    )
    .limit(1);

  if (!user) throw Errors.unauthorized();
  // Soft-delete sentinel — once `deleted_at` is set, the row exists
  // for FK integrity (transactions, requests) but the holder is
  // GDPR-deleted. Treat the API key as revoked.
  if (user.deletedAt) throw Errors.unauthorized();

  c.set('user', user);
  await next();
}

export async function adminAuth(c: Context, next: Next) {
  const header = c.req.header('x-admin-key');
  if (!header || !constantTimeEqual(header, env.ADMIN_API_KEY)) {
    throw Errors.forbidden();
  }
  await next();
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
