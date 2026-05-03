import { Hono } from 'hono';
import '~/types'; // Hono context variable typings
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { env } from '~/config';
import { AppError } from '~/lib/errors';
import { log } from '~/lib/logger';
import { apiKeyAuth } from '~/auth/middleware';
import { rateLimit } from '~/middleware/rate-limit';
import { publicRateLimit } from '~/middleware/public-rate-limit';
import { requestId } from '~/middleware/request-id';
import { watchRegistry } from '~/registry/apis';
import { x402Middleware } from '~/payment/x402';
import { ensureCriticalSchema, ensureSystemRows } from '~/db/bootstrap';
import { redis } from '~/cache/redis';

import walletRoutes, { admin as adminWalletRoutes } from '~/routes/wallet';
import apiRoutes from '~/routes/apis';
import callRoutes from '~/routes/call';
import usageRoutes from '~/routes/usage';
import webhookRoutes from '~/routes/webhooks';
import policyRoutes from '~/routes/policy';
import settlementRoutes from '~/routes/settlement';
import operatorRoutes from '~/routes/operator';
import signupRoutes from '~/routes/signup';
import authPrivyRoutes from '~/routes/auth-privy';
import authSupabaseRoutes from '~/routes/auth-supabase';
import subscriptionRoutes, { publicRoutes as subscriptionPublicRoutes, adminCronRoutes as subscriptionAdminCron } from '~/routes/subscription';
import agentsRoutes, { publicRoutes as agentsPublicRoutes } from '~/routes/agents';
import agentRunRoutes from '~/routes/agent-run';
import { ownerWhatsapp, publicWebhook as whatsappPublicWebhook } from '~/routes/whatsapp';
import { ownerContacts } from '~/routes/contacts';
import { ownerAppointments, ownerAppointmentsRoot, adminCron } from '~/routes/appointments';
import { ownerSubscriptions, ownerSubscriptionsRoot, adminSubscriptionsCron } from '~/routes/subscriptions';
import { nftMetaRoutes } from '~/routes/nft-metadata';
import { checkoutRoutes } from '~/routes/checkout';
import { previewRoutes } from '~/routes/preview';
import { personaRoutes } from '~/routes/personas';
import statsRoutes from '~/routes/stats';
import metricsRoutes from '~/routes/metrics';
import webhookSubsRoutes from '~/routes/webhook-subs';
import { affiliateRoutes } from '~/routes/affiliate';
import voicesRoutes from '~/routes/voices';
import auditRoutes from '~/routes/audit';
import meRoutes from '~/routes/me';
import mfaRoutes from '~/routes/mfa';

const app = new Hono();

// Request ID first so all subsequent middleware + logs see it.
app.use('*', requestId);
// secureHeaders defaults Cross-Origin-Resource-Policy to 'same-origin', which
// silently blocks <img> loads of our public assets (persona avatars, NFT
// metadata) from the Cloudflare Pages frontend on a different domain. Set
// to 'cross-origin' globally — CORS still gates who can READ data via fetch.
app.use('*', secureHeaders({
  crossOriginResourcePolicy: 'cross-origin',
}));
// CORS: lock to configured frontend origins in prod. Pre-flight + credentials
// are restricted to known hosts so browser-side session theft is not possible.
const allowedOrigins = env.CORS_ALLOWED_ORIGINS;
app.use(
  '*',
  cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
    allowHeaders: ['x-api-key', 'x-admin-key', 'content-type', 'authorization'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: [
      'x-axon-cost-usdc',
      'x-axon-cache',
      'x-axon-latency-ms',
      'x-axon-fallback',
      'x-request-id',
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ],
    maxAge: 600,
  }),
);

// Access log (structured — one JSON line per request in prod)
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const elapsed = Date.now() - start;
  log.info('http', {
    request_id: c.get('request_id'),
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

// Build probe — public, no auth. Lets the brain UI (and operators with a
// curl) verify which feature wave is actually live. The very existence of
// this endpoint means the brain instrumentation deploy went through.
app.get('/build', (c) => c.json({
  features: {
    brain_meta: true,        // agent_messages.meta JSONB persisted per turn
    judge_layer: true,       // src/agents/judge.ts active
    arc_evaluation: true,    // contact_memory.arc per-conversation
    health_endpoint: true,   // /v1/agents/:id/health
    patches_endpoint: true,  // /v1/agents/:id/patches + /apply
  },
  built_at: new Date().toISOString(),
}));

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
// Public routes share one IP-keyed rate limiter so a scraper can't
// hammer the catalog DB. 120/min covers legitimate dashboard use
// (which polls /v1/stats/public + /v1/apis) and shared-NAT mobile
// carriers without false-positives.
const publicCatalogRl = publicRateLimit({ perMin: 120, bucket: 'catalog' });
app.use('/v1/apis/*', publicCatalogRl);
app.use('/v1/stats/*', publicCatalogRl);
app.route('/v1/apis', apiRoutes);
app.route('/v1/stats', statsRoutes);
app.route('/metrics', metricsRoutes);

// ─── x402 native (no API key, pay on-chain per call) ──
// Only mounted when the feature flag is on. When off, hitting /x402/v1/*
// returns a 404 via app.notFound — no fallthrough to the call engine.
if (env.ENABLE_X402_NATIVE) {
  const x402V1 = new Hono();
  x402V1.use('*', x402Middleware);
  x402V1.route('/call', callRoutes);
  app.route('/x402/v1', x402V1);
}

// ─── Admin endpoints (header: x-admin-key) ────────────
// MUST be mounted BEFORE the authed /v1 sub-router so that /v1/admin/*
// doesn't get caught by apiKeyAuth on /v1.
app.route('/v1/admin', adminWalletRoutes);
app.route('/v1/admin/policy', policyRoutes);
app.route('/v1/admin/settlements', settlementRoutes);
app.route('/v1/admin/operator', operatorRoutes);
app.route('/v1/admin/audit', auditRoutes);
// Cron-only admin route: appointment reminders. Auth = x-admin-key shared
// secret with the GitHub Action that calls it daily. Mounted BEFORE the
// authed /v1 router so the api-key middleware doesn't shadow it.
app.route('/v1/admin', adminCron);
app.route('/v1/admin', adminSubscriptionsCron);
app.route('/v1/admin', subscriptionAdminCron);

// ─── Public signup (no auth, IP rate-limited) ─────────
// MUST be mounted BEFORE the authed /v1 sub-router.
app.route('/v1/signup', signupRoutes);
app.route('/v1/auth/privy', authPrivyRoutes);
app.route('/v1/auth/supabase', authSupabaseRoutes);
app.route('/v1/subscription', subscriptionPublicRoutes);
app.route('/v1/agents', agentsPublicRoutes);
// Preview routes mounted at /v1/agents/* — reuse the same prefix.
app.route('/v1/agents', previewRoutes);
app.route('/v1/run', agentRunRoutes);
// Inbound WhatsApp from Evolution servers — no auth, secret in path is the auth.
// MUST go before the authed /v1 router for the same reason as /v1/signup.
app.route('/v1/webhooks/whatsapp', whatsappPublicWebhook);
// Public NFT metadata — fetched by marketplaces (OpenSea, Basescan) at the
// tokenURI of every minted agent NFT. Must be unauthenticated.
// Same scraper-resistance for NFT metadata (marketplaces hit this) and
// the public personas gallery. 240/min — marketplaces refresh in bursts.
const publicAssetRl = publicRateLimit({ perMin: 240, bucket: 'asset' });
app.use('/agent-meta/*', publicAssetRl);
app.use('/v1/personas/*', publicAssetRl);
app.route('/agent-meta', nftMetaRoutes);
// Public personas API — gallery + avatar SVGs.
app.route('/v1/personas', personaRoutes);

// ─── Webhooks (signature-verified, no auth middleware) ──
// MUST be mounted BEFORE the authed /v1 sub-router so the apiKeyAuth
// middleware doesn't shadow the public webhook endpoints (alchemy,
// mercadopago, manual). Same reason /v1/signup, /v1/auth/privy, and
// /v1/webhooks/whatsapp are mounted earlier.
app.route('/v1/webhooks', webhookRoutes);

// ─── Authed: wallet, calls, usage ─────────────────────
const v1 = new Hono();
v1.use('*', apiKeyAuth);
v1.use('*', rateLimit);
v1.route('/wallet', walletRoutes);
v1.route('/call', callRoutes);
v1.route('/usage', usageRoutes);
v1.route('/subscription', subscriptionRoutes);
v1.route('/agents', agentsRoutes);
v1.route('/agents', ownerWhatsapp);  // adds /v1/agents/:id/whatsapp under same auth
v1.route('/agents', ownerContacts);  // adds /v1/agents/:id/contacts/* under same auth
v1.route('/agents', ownerAppointments);     // /v1/agents/:id/{appointments,contacts/:phone/appointments}
v1.route('/', ownerAppointmentsRoot);       // /v1/appointments/:id PATCH/DELETE
v1.route('/agents', ownerSubscriptions);    // /v1/agents/:id/subscription
v1.route('/', ownerSubscriptionsRoot);      // /v1/subscriptions (list per owner)
v1.route('/checkout', checkoutRoutes);  // POST /v1/checkout/pix + status polling
v1.route('/webhook-subscriptions', webhookSubsRoutes);
v1.route('/affiliate', affiliateRoutes);  // earnings + agent list for referrers
v1.route('/voices', voicesRoutes);        // picker / preview / clone / delete
v1.route('/users', meRoutes);             // GET /me, GET /me/export, DELETE /me
v1.route('/auth/2fa', mfaRoutes);         // TOTP setup / verify / check / disable
app.route('/v1', v1);

// ─── Error handler ────────────────────────────────────
app.onError((err, c) => {
  const rid = c.get('request_id');
  if (err instanceof AppError) {
    log.warn('app_error', {
      request_id: rid,
      code: err.code,
      status: err.status,
      message: err.message,
    });
    // Counter so we can graph error rate by code in Prometheus.
    void import('~/lib/metrics').then(({ bumpCounter }) => {
      bumpCounter('axon_app_errors_total', {
        code: err.code,
        severity: err.status >= 500 ? 'error' : 'warn',
      });
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
  void import('~/lib/metrics').then(({ bumpCounter }) => {
    bumpCounter('axon_app_errors_total', { code: 'unhandled', severity: 'error' });
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

// Critical schema DDL — MUST complete before the server answers any request,
// otherwise Drizzle SELECTs that reference newly-added columns will throw.
// Awaited at top level so Bun delays starting the listener until the column
// adds are committed. Fast (<50ms) since it's just IF NOT EXISTS checks.
await ensureCriticalSchema().catch((err) => {
  log.error('critical_schema_failed', { error: (err as Error).message });
  // Re-throw so the deploy fails loudly instead of silently serving broken queries.
  throw err;
});

// Bootstrap DB (idempotent). Runs in background so import order isn't
// blocked on a slow DB connect; the server still answers /health while
// bootstrap finishes.
ensureSystemRows().catch((err) => {
  log.error('bootstrap_failed', { error: (err as Error).message });
});

// Graceful shutdown — Render/Railway/Fly send SIGTERM before killing
// the container. Drain Postgres pool first so in-flight queries either
// commit or fail cleanly with a connection error (rather than the
// process disappearing mid-write). 5s overall budget; if drain hangs,
// kill anyway so the orchestrator's SIGKILL doesn't take effect at a
// random instruction.
let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_begin', { signal });
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  try {
    const { drainPool } = await import('~/db');
    await Promise.race([
      drainPool(),
      new Promise((r) => setTimeout(r, deadline - Date.now())),
    ]);
  } catch {
    // best-effort
  }
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
