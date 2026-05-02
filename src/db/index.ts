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

// Pool sizing — Neon free tier allows 100 simultaneous connections.
// We run one Render instance and consume 20 connections at peak for
// burst tolerance during traffic spikes. Statement timeout caps any
// runaway query at 30s (catches a missing index in production before
// it brings the whole pool down). Idle-in-transaction kills sessions
// that BEGIN'd but never committed — usually a bug, but caps damage.
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Postgres-side timeouts: applied to every backend session.
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 30_000,
  application_name: 'axon',
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

// Surface pool errors instead of letting them crash the worker.
// pg.Pool emits 'error' on idle clients that hit fatal connection issues.
pool.on('error', (err) => {
  console.error('[pg.Pool] idle client error:', err.message);
});

/**
 * Graceful shutdown — drain in-flight queries, close pooled clients
 * BEFORE process.exit. Called from the SIGTERM handler in src/index.ts.
 * Idempotent.
 */
let _draining: Promise<void> | null = null;
export function drainPool(): Promise<void> {
  if (_draining) return _draining;
  _draining = (async () => {
    try {
      await pool.end();
    } catch (err) {
      console.error('[pg.Pool] drain error:', err instanceof Error ? err.message : err);
    }
  })();
  return _draining;
}

export const db = drizzle(pool, { schema });
export { schema };
