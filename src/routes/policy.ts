import { Hono } from 'hono';
import { adminAuth } from '~/auth/middleware';
import { loadPolicy, upsertPolicy, deletePolicy } from '~/policy/engine';
import type { Policy } from '~/policy/types';
import { Errors } from '~/lib/errors';

const app = new Hono();

// ─── GET  /v1/admin/policy/:user_id ─────────────────
app.get('/:user_id', adminAuth, async (c) => {
  const userId = c.req.param('user_id')!;
  const policy = await loadPolicy(userId);
  return c.json({ user_id: userId, policy });
});

// ─── PUT  /v1/admin/policy/:user_id ─────────────────
app.put('/:user_id', adminAuth, async (c) => {
  const userId = c.req.param('user_id')!;
  const rules = (await c.req.json()) as Policy;
  validate(rules);
  await upsertPolicy(userId, rules);
  return c.json({ ok: true, user_id: userId, policy: rules });
});

// ─── DELETE /v1/admin/policy/:user_id ───────────────
app.delete('/:user_id', adminAuth, async (c) => {
  const userId = c.req.param('user_id')!;
  await deletePolicy(userId);
  return c.json({ ok: true });
});

function validate(rules: Policy) {
  const bigints = [
    'daily_budget_micro',
    'monthly_budget_micro',
    'max_request_cost_micro',
  ] as const;
  for (const k of bigints) {
    const v = rules[k];
    if (v !== undefined && !/^\d+$/.test(v)) {
      throw Errors.badRequest(`${k} must be a positive integer string (micro-USDC)`);
    }
  }
  if (rules.per_api_daily_micro) {
    for (const [slug, v] of Object.entries(rules.per_api_daily_micro)) {
      if (!/^\d+$/.test(v)) {
        throw Errors.badRequest(
          `per_api_daily_micro.${slug} must be a positive integer string`,
        );
      }
    }
  }
}

export default app;
