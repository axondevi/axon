import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '~/config';
import * as schema from './schema';

// SSL handling: managed providers (Render, Neon, Fly Postgres) all enforce
// TLS at the connection layer, so the URL typically already includes
// `?sslmode=require`. We pass `ssl: { rejectUnauthorized: false }` only
// when the URL doesn't request SSL and we're in production — that lets
// older self-hosted deploys with self-signed certs still connect, while
// production-managed connections get full TLS verification via the URL.
const useSsl = env.NODE_ENV === 'production' && !/sslmode=/.test(env.DATABASE_URL);

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

export const db = drizzle(pool, { schema });
export { schema };
