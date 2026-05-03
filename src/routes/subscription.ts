import { Hono } from 'hono';
import {
  subscribe,
  cancelAutoRenew,
  getSubscription,
  TIER_PRICES,
  TIER_MARKUP_DISCOUNT_PCT,
  TIER_RATE_LIMITS,
  PERIOD_DAYS,
  type Tier,
} from '~/subscription';
import { fromMicro } from '~/wallet/service';
import { Errors } from '~/lib/errors';

const app = new Hono();

// Public router — mounted at /v1/subscription/plans BEFORE the authed scope
// so the upgrade page (and any SDK) can read plan info without an API key.
export const publicRoutes = new Hono();
publicRoutes.get('/plans', (c) => {
  const plans = (['free', 'pro', 'team', 'enterprise'] as Tier[]).map((tier) => ({
    tier,
    price_usdc: fromMicro(TIER_PRICES[tier]),
    period_days: PERIOD_DAYS,
    rate_limit_per_min: TIER_RATE_LIMITS[tier],
    markup_discount_pct: TIER_MARKUP_DISCOUNT_PCT[tier],
    self_service: tier !== 'enterprise',
  }));
  return c.json({ plans });
});

// ─── GET /v1/subscription ───────────────────────────────
// Current state for the authenticated user.
app.get('/', async (c) => {
  const user = c.get('user') as { id: string };
  const sub = await getSubscription(user.id);
  return c.json(sub);
});

// ─── POST /v1/subscription/subscribe ────────────────────
// Body: { tier: 'pro' | 'team', auto_renew?: boolean }
// Debits the wallet and activates / extends the period.
app.post('/subscribe', async (c) => {
  const user = c.get('user') as { id: string };
  const body = await c.req.json().catch(() => ({}));
  const tier = body.tier as string | undefined;
  if (tier !== 'pro' && tier !== 'team') {
    throw Errors.badRequest('tier must be one of: pro, team');
  }
  const result = await subscribe(user.id, tier, {
    autoRenew: body.auto_renew !== false,
  });
  // result.charged_micro is a bigint — JSON.stringify throws on bigints,
  // so we must NOT spread it raw into the response body
  return c.json({
    ok: true,
    tier: result.tier,
    expires_at: result.expires_at,
    auto_renew: result.auto_renew,
    charged_usdc: fromMicro(result.charged_micro),
  });
});

// ─── POST /v1/subscription/cancel ───────────────────────
// Disables auto-renew. The user keeps the active tier until tier_expires_at.
app.post('/cancel', async (c) => {
  const user = c.get('user') as { id: string };
  const result = await cancelAutoRenew(user.id);
  return c.json({ ok: true, ...result });
});

// Admin-only cron endpoints for the user-tier subscription lifecycle
// (free / pro / team rollover). The per-agent plan billing lives in
// routes/subscriptions.ts — this file handles the older user-level
// monthly tier subscriptions. Mounted under /v1/admin/cron/* in
// src/index.ts. Both endpoints accept ADMIN_API_KEY via x-admin-key.
export const adminCronRoutes = new Hono();

adminCronRoutes.post('/cron/user-subscription-rollover', async (c) => {
  const adminKey = c.req.header('x-admin-key');
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const { processExpiringSubscriptions } = await import('~/subscription');
  const result = await processExpiringSubscriptions();
  return c.json(result);
});

adminCronRoutes.post('/cron/user-subscription-notify', async (c) => {
  const adminKey = c.req.header('x-admin-key');
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json().catch(() => ({} as { days_ahead?: number }));
  const { notifyExpiringSubscriptions } = await import('~/subscription');
  const result = await notifyExpiringSubscriptions({ daysAhead: body.days_ahead });
  return c.json(result);
});

export default app;
