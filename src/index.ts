import { Hono } from 'hono';
import '~/types'; // Hono context variable typings
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { env } from '~/config';
import { AppError } from '~/lib/errors';
import { log } from '~/lib/logger';
import { apiKeyAuth } from '~/auth/middleware';
import { rateLimit } from '~/middleware/rate-limit';
import { requestId } from '~/middleware/request-id';
import { watchRegistry } from '~/registry/apis';
import { x402Middleware } from '~/payment/x402';
import { ensureSystemRows } from '~/db/bootstrap';
import { redis } from '~/cache/redis';

import walletRoutes, { admin as adminWalletRoutes } from '~/routes/wallet';
import apiRoutes from '~/routes/apis';
import callRoutes from '~/routes/call';
import usageRoutes from '~/routes/usage';
import webhookRoutes from '~/routes/webhooks';
import policyRoutes from '~/routes/policy';
import settlementRoutes from '~/routes/settlement';
import statsRoutes from '~/routes/stats';
import metricsRoutes from '~/routes/metrics';
import webhookSubsRoutes from '~/routes/webhook-subs';

const app = new Hono();

// Request ID first so all subsequent middleware + logs see it.
app.use('*', requestId);
app.use('*', secureHeaders());
app.use('*', cors({ origin: '*', allowHeaders: ['x-api-key', 'content-type', 'authorization'] }));

// Access log (structured — one JSON line per request in prod)
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const elapsed = Date.now() - start;
  log.info('http', {
    request_id: c.get('request_id' as any),
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    ms: elapsed,
  });
});

// ─── Health ───────────────────────────────────────────
app.get('/', (c) =>
  c.json({ name: 'axon', version: '0.1.0', status: 'ok' }),
);
app.get('/health', (c) => c.json({ status: 'ok' }));

// Readiness — checks DB and Redis are reachable. Use for k8s/Railway probes.
app.get('/health/ready', async (c) => {
  try {
    await redis.ping();
    // DB check: cheap SELECT 1 via drizzle
    const { db } = await import('~/db');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`SELECT 1`);
    return c.json({ status: 'ready' });
  } catch (err) {
    return c.json(
      { status: 'not_ready', error: (err as Error).message },
      503,
    );
  }
});

// ─── Public: catalog + stats + metrics ────────────────
app.route('/v1/apis', apiRoutes);
app.route('/v1/stats', statsRoutes);
app.route('/metrics', metricsRoutes);

// ─── x402 native (no API key, pay on-chain per call) ──
const x402V1 = new Hono();
x402V1.use('*', x402Middleware);
x402V1.route('/call', callRoutes);
app.route('/x402/v1', x402V1);

// ─── Admin endpoints (header: x-admin-key) ────────────
// MUST be mounted BEFORE the authed /v1 sub-router so that /v1/admin/*
// doesn't get caught by apiKeyAuth on /v1.
app.route('/v1/admin', adminWalletRoutes);
app.route('/v1/admin/policy', policyRoutes);
app.route('/v1/admin/settlements', settlementRoutes);

// ─── Authed: wallet, calls, usage ─────────────────────
const v1 = new Hono();
v1.use('*', apiKeyAuth);
v1.use('*', rateLimit);
v1.route('/wallet', walletRoutes);
v1.route('/call', callRoutes);
v1.route('/usage', usageRoutes);
v1.route('/webhook-subscriptions', webhookSubsRoutes);
app.route('/v1', v1);

// ─── Webhooks (signature-verified, no auth middleware) ──
app.route('/v1/webhooks', webhookRoutes);

// ─── Error handler ────────────────────────────────────
app.onError((err, c) => {
  const rid = c.get('request_id' as any);
  if (err instanceof AppError) {
    log.warn('app_error', {
      request_id: rid,
      code: err.code,
      status: err.status,
      message: err.message,
    });
    return c.json(
      { error: err.code, message: err.message, meta: err.meta, request_id: rid },
      err.status as any,
    );
  }
  log.error('unhandled', {
    request_id: rid,
    error: err.message,
    // stack only in dev — never leak to clients
    ...(env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
  });
  return c.json(
    {
      error: 'internal',
      message: 'Internal server error',
      request_id: rid,
    },
    500,
  );
});

app.notFound((c) =>
  c.json({ error: 'not_found', message: 'Route not found' }, 404),
);

watchRegistry();

// Bootstrap DB (idempotent). Runs in background so import order isn't
// blocked on a slow DB connect; the server still answers /health while
// bootstrap finishes.
ensureSystemRows().catch((err) => {
  log.error('bootstrap_failed', { error: (err as Error).message });
});

// Graceful shutdown — Railway/Fly send SIGTERM before killing the container.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_begin', { signal });
  try {
    await redis.quit();
  } catch {
    // best-effort
  }
  log.info('shutdown_complete');
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log.info('axon_ready', { port: env.PORT, env: env.NODE_ENV });

export default {
  port: env.PORT,
  fetch: app.fetch,
};
