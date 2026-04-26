/**
 * Owner-paid agent runner — public endpoint that proxies a tool call to
 * Axon on behalf of the agent's owner.
 *
 * Flow:
 *   POST /v1/run/:slug/:api/:endpoint
 *     1. Look up the agent by slug
 *     2. Reject if pay_mode != 'owner' (visitor-pay agents must use the
 *        normal authed flow with their own API key)
 *     3. Reject if API/endpoint not in agent.allowed_tools
 *     4. Daily budget check (resets at UTC midnight; tracked in Redis)
 *     5. IP-based rate limit (cheap abuse mitigation)
 *     6. Inject the owner as the authenticated user, then defer to the
 *        same wrapper engine the regular /v1/call/* path uses
 *
 * The agent runner page sends Groq chat completions through this same
 * endpoint, so /v1/run/:slug/groq/chat is the LLM dispatch and
 * /v1/run/:slug/:api/:endpoint covers all tool dispatch from agent-runner.
 *
 * Security notes:
 *   - allowed_tools whitelist prevents agents from calling APIs the owner
 *     didn't pre-approve (so a poisoned prompt can't drain the wallet
 *     by calling, say, a paid LLM that wasn't in the agent's spec)
 *   - owner is loaded fresh per request (DB hit) — small price for
 *     correctness. Cache-able in Redis later if RPS becomes an issue.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '~/db';
import { users, agents } from '~/db/schema';
import { redis } from '~/cache/redis';
import { Errors } from '~/lib/errors';
import { handleCall } from '~/wrapper/engine';
import { isToolAllowed } from '~/agents/templates';

const app = new Hono();

const VISITOR_RATE_LIMIT_PER_MIN = 30; // shared per IP per agent
const VISITOR_WINDOW_SEC = 60;

function clientIp(c: Context): string {
  const fwd = c.req.header('cf-connecting-ip') ||
              c.req.header('x-forwarded-for') ||
              c.req.header('x-real-ip') ||
              '0.0.0.0';
  return String(fwd).split(',')[0].trim();
}

function utcDayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Allowed pseudo-API for LLM dispatch — agents always call this even if it isn't
// in allowed_tools (the agent IS the LLM call; the tool whitelist is for what the
// LLM can in turn invoke). We still respect the agent's own pay-mode + budget.
const LLM_PASSTHROUGH = new Set(['groq']);

app.post('/:slug/:api/:endpoint', async (c) => {
  const slug = c.req.param('slug');
  const api = c.req.param('api');
  const endpoint = c.req.param('endpoint');

  const [agent] = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
  if (!agent || !agent.public) throw Errors.notFound('Agent');
  if (agent.payMode !== 'owner') {
    throw Errors.forbidden();
  }

  // Whitelist: LLM dispatch is always allowed; tool dispatch must be backed by
  // a tool in agent.allowed_tools (mapped via TOOL_TO_AXON in agents/templates).
  if (!LLM_PASSTHROUGH.has(api)) {
    if (!isToolAllowed(agent.allowedTools, api, endpoint)) {
      throw Errors.forbidden();
    }
  }

  // Per-IP rate limit (cheap abuse mitigation)
  const ip = clientIp(c);
  const rlKey = `agentrun:${slug}:${ip}:${Math.floor(Date.now() / 1000 / VISITOR_WINDOW_SEC)}`;
  const count = await redis.incr(rlKey);
  if (count === 1) await redis.expire(rlKey, VISITOR_WINDOW_SEC + 5);
  if (count > VISITOR_RATE_LIMIT_PER_MIN) {
    return c.json({ error: 'rate_limited', message: `Too many requests. Try again in ${VISITOR_WINDOW_SEC}s.` }, 429);
  }

  // Daily budget check (UTC). Tracks reserved + spent for the agent.
  const dayKey = `agentbudget:${agent.id}:${utcDayKey()}`;
  const spentRaw = await redis.get(dayKey);
  const spent = BigInt(spentRaw ?? '0');
  if (spent >= agent.dailyBudgetMicro) {
    return c.json({
      error: 'agent_budget_exhausted',
      message: 'This agent has reached its daily spending cap. Please try again tomorrow.',
      meta: { reset_at: 'utc_midnight' },
    }, 402);
  }

  // Load owner row to inject as authed user
  const [owner] = await db.select().from(users).where(eq(users.id, agent.ownerId)).limit(1);
  if (!owner) throw Errors.notFound('Agent owner');

  c.set('user', owner);
  // Stamp agent_id so the engine writes it on every requests row → analytics
  c.set('axon:agent_id', agent.id);

  // Tag the response so the runner can show "powered by owner" feel
  c.header('x-axon-agent-slug', slug);
  c.header('x-axon-pay-mode', 'owner');

  // Delegate to the same handler /v1/call/* uses, but with explicit slug+endpoint
  // (we can't trust c.req.param('slug') here — it'd return our agent slug)
  const res = await handleCall(c, { slug: api, endpoint });

  // After the call, read the cost header the engine emitted and bump our
  // daily counter. We cannot reach into the response body, but the engine
  // sets x-axon-cost-usdc on the same response we return.
  // Note: hono Response headers are read-only at this point in some
  // versions, so we re-read via a clone.
  try {
    const cloned = res.clone();
    const cost = parseFloat(cloned.headers.get('x-axon-cost-usdc') || '0') || 0;
    if (cost > 0) {
      const microPaid = BigInt(Math.round(cost * 1_000_000));
      await redis.incrby(dayKey, microPaid.toString());
      // Expire 36h from now so we don't leak keys forever
      await redis.expire(dayKey, 36 * 60 * 60);
    }
  } catch { /* non-fatal */ }

  return res;
});

export default app;
