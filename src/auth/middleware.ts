import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
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

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.apiKeyHash, hash))
    .limit(1);

  if (!user) throw Errors.unauthorized();

  c.set('user', user);
  await next();
}

export async function adminAuth(c: Context, next: Next) {
  const header = c.req.header('x-admin-key');
  if (!header || header !== env.ADMIN_API_KEY) {
    throw Errors.forbidden();
  }
  await next();
}
