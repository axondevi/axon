import type { Context } from 'hono';
import { getApi } from '~/registry/apis';
import type { ApiConfig, AuthType, EndpointConfig } from '~/registry/types';
import { redis } from '~/cache/redis';
import { cacheKey } from './cache-key';
import { debit, credit, toMicro } from '~/wallet/service';
import { db } from '~/db';
import { requests } from '~/db/schema';
import { Errors } from '~/lib/errors';
import { upstreamKeyFor } from '~/config';
import { enforcePolicy } from '~/policy/engine';
import { calculatorFor } from '~/metering';
import { X402_ANON_USER_ID } from '~/db/bootstrap';
import { effectiveTier, TIER_MARKUP_DISCOUNT_PCT } from '~/subscription';

const CACHE_DISCOUNT_PCT = 50; // cached responses charge 50% of full price

interface CallContext {
  userId: string;
  slug: string;
  endpointKey: string;
  api: ApiConfig;
  endpoint: EndpointConfig;
  params: Record<string, unknown>;
  body: unknown | undefined;
  /** Effective markup_pct after applying the user's tier discount (free=full, pro=-25%, …) */
  effectiveMarkupPct: number;
  /** True when this call was settled via x402 native on-chain payment. */
  x402Paid: boolean;
}

export async function handleCall(
  c: Context,
  opts?: { slug?: string; endpoint?: string },
) {
  const slug = opts?.slug ?? c.req.param('slug')!;
  const endpointKey = opts?.endpoint ?? c.req.param('endpoint')!;
  const x402Paid = !!c.get('axon:x402_paid');
  const user = (c.get('user') as { id: string; tier?: string; tierExpiresAt?: Date | null } | undefined) ?? {
    // Synthetic user for x402-native calls. Created at boot by
    // ensureSystemRows() so the FK on requests.user_id resolves.
    id: X402_ANON_USER_ID,
  };

  const api = getApi(slug);
  if (!api) throw Errors.notFound(`API '${slug}'`);

  const endpoint = api.endpoints[endpointKey];
  if (!endpoint) throw Errors.notFound(`Endpoint '${endpointKey}'`);

  // Tier-based markup discount. effectiveTier handles expiry, so a lapsed
  // Pro user's calls already pay the full free-tier markup.
  const tier = effectiveTier({ tier: user.tier ?? 'free', tierExpiresAt: user.tierExpiresAt ?? null });
  const discount = TIER_MARKUP_DISCOUNT_PCT[tier] ?? 0;
  const effectiveMarkupPct = Math.max(0, Math.round(endpoint.markup_pct * (100 - discount) / 100));

  const url = new URL(c.req.url);
  const params: Record<string, unknown> = {};
  url.searchParams.forEach((v, k) => (params[k] = v));

  let body: unknown;
  if (['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
  }

  const ctx: CallContext = {
    userId: user.id,
    slug,
    endpointKey,
    api,
    endpoint,
    params,
    body,
    effectiveMarkupPct,
    x402Paid,
  };

  return await execute(c, ctx);
}

async function execute(c: Context, ctx: CallContext) {
  const startedAt = Date.now();

  // 1. Cache check
  const key = cacheKey(
    ctx.slug,
    ctx.endpointKey,
    ctx.params,
    ctx.endpoint.cache_on_body ? ctx.body : undefined,
  );

  if (ctx.endpoint.cache_ttl > 0) {
    const cached = await redis.get(key);
    if (cached) {
      if (!ctx.x402Paid) {
        const cachedCost = (toMicro(ctx.endpoint.price_usd) * 50n) / 100n;
        await enforcePolicy({
          userId: ctx.userId,
          slug: ctx.slug,
          estimatedCostMicro: cachedCost,
          cacheHit: true,
        });
      }
      return await serveCacheHit(c, ctx, key, cached, startedAt);
    }
  }

  // 2. Cache miss → charge full price up front, call upstream
  const fullCostMicro = toMicro(ctx.endpoint.price_usd);
  const markupMicro =
    (fullCostMicro * BigInt(ctx.effectiveMarkupPct)) / 100n;
  const totalMicro = fullCostMicro + markupMicro;

  if (!ctx.x402Paid) {
    await enforcePolicy({
      userId: ctx.userId,
      slug: ctx.slug,
      estimatedCostMicro: totalMicro,
      cacheHit: false,
    });

    await debit({
      userId: ctx.userId,
      amountMicro: totalMicro,
      apiSlug: ctx.slug,
      meta: { cached: false, endpoint: ctx.endpointKey },
    });
  }

  let upstreamRes: Response;
  let usedFallback: { slug: string; endpoint: string } | null = null;
  try {
    const outcome = await callWithFallback(ctx);
    upstreamRes = outcome.response;
    usedFallback = outcome.usedFallback;
  } catch (err) {
    if (!ctx.x402Paid) await refund(ctx, totalMicro, 'upstream_network_error');
    throw Errors.upstreamFailed(ctx.slug, 0);
  }

  const status = upstreamRes.status;
  const contentType = upstreamRes.headers.get('content-type') ?? 'application/json';

  if (status >= 400) {
    if (!ctx.x402Paid) await refund(ctx, totalMicro, `upstream_${status}`);
    const errBody = await upstreamRes.text();
    const extra: Record<string, string> = {
      'content-type': contentType,
      'x-axon-refunded': ctx.x402Paid ? 'false' : 'true',
    };
    if (usedFallback)
      extra['x-axon-fallback'] = `${usedFallback.slug}/${usedFallback.endpoint}`;
    return c.text(errBody, status as any, extra);
  }

  const payload = await upstreamRes.text();

  if (ctx.endpoint.cache_ttl > 0 && contentType.includes('json')) {
    await redis.setex(key, ctx.endpoint.cache_ttl, payload);
  }

  // ─── Per-token metering reconciliation ──────────────
  // Use the SERVED slug/endpoint (fallback-aware) so we pick the right
  // calculator when the actual response came from a different provider.
  const servedSlug = usedFallback?.slug ?? ctx.slug;
  const servedEndpoint = usedFallback?.endpoint ?? ctx.endpointKey;

  let reconciledCost = fullCostMicro;
  let reconciledMarkup = markupMicro;
  const calc = calculatorFor(servedSlug, servedEndpoint);
  if (!ctx.x402Paid && calc && contentType.includes('json')) {
    try {
      const parsed = JSON.parse(payload);
      const m = calc({
        slug: servedSlug,
        endpoint: servedEndpoint,
        responseBody: parsed,
        requestBody: ctx.body,
        estimatedCostMicro: fullCostMicro,
      });
      if (m.actualCostMicro !== undefined) {
        reconciledCost = m.actualCostMicro;
        reconciledMarkup =
          (reconciledCost * BigInt(ctx.effectiveMarkupPct)) / 100n;
        const newTotal = reconciledCost + reconciledMarkup;
        if (newTotal < totalMicro) {
          await credit({
            userId: ctx.userId,
            amountMicro: totalMicro - newTotal,
            type: 'refund',
            meta: {
              reason: 'metering_reconciliation',
              served_by: servedSlug,
              endpoint: servedEndpoint,
              estimated_micro: totalMicro.toString(),
              actual_micro: newTotal.toString(),
              ...(m.notes ?? {}),
            },
          });
        } else if (newTotal > totalMicro) {
          try {
            await debit({
              userId: ctx.userId,
              amountMicro: newTotal - totalMicro,
              apiSlug: ctx.slug,
              meta: {
                reason: 'metering_topup',
                served_by: servedSlug,
                endpoint: servedEndpoint,
                estimated_micro: totalMicro.toString(),
                actual_micro: newTotal.toString(),
                ...(m.notes ?? {}),
              },
            });
          } catch {
            // Client underpaid — log but don't fail the response they
            // already consumed. Next call will trip insufficient_funds.
          }
        }
      }
    } catch {
      // JSON parse failed — keep flat estimate
    }
  }

  const latency = Date.now() - startedAt;

  // Log under the SERVED slug so settlement pays the right upstream.
  // The originally-requested slug is kept in `requests.endpoint` when a
  // fallback was used (format: "{requestedEndpoint}@{requestedSlug}") so
  // we don't lose analytic lineage.
  await db.insert(requests).values({
    userId: ctx.userId,
    apiSlug: servedSlug,
    endpoint: usedFallback
      ? `${servedEndpoint}@${ctx.slug}:${ctx.endpointKey}`
      : ctx.endpointKey,
    costMicro: reconciledCost,
    markupMicro: reconciledMarkup,
    cacheHit: false,
    latencyMs: latency,
    status,
  });

  const finalTotal = reconciledCost + reconciledMarkup;
  const outHeaders: Record<string, string> = {
    'content-type': contentType,
    'x-axon-cost-usdc': formatUsdc(finalTotal),
    'x-axon-cache': 'miss',
    'x-axon-latency-ms': String(latency),
  };
  if (usedFallback)
    outHeaders['x-axon-fallback'] = `${usedFallback.slug}/${usedFallback.endpoint}`;
  return c.body(payload, 200, outHeaders);
}

/**
 * Try primary upstream. On transport error or 5xx / 429, walk the fallback
 * list in order. Each attempt obeys the endpoint's `timeout_ms` if set.
 *
 * Returns the first usable Response (2xx-4xx except retry-worthy codes) plus
 * which fallback (if any) was used. If the primary succeeds, usedFallback is
 * null.
 */
async function callWithFallback(
  ctx: CallContext,
): Promise<{ response: Response; usedFallback: { slug: string; endpoint: string } | null }> {
  const primary = await tryOnce(ctx);
  if (isUsable(primary)) {
    return { response: primary.response!, usedFallback: null };
  }

  const fallbacks = ctx.endpoint.fallbacks ?? [];
  for (const fb of fallbacks) {
    const api = getApi(fb.slug);
    if (!api) continue;
    const endpoint = api.endpoints[fb.endpoint];
    if (!endpoint) continue;

    const fbCtx: CallContext = {
      ...ctx,
      slug: fb.slug,
      endpointKey: fb.endpoint,
      api,
      endpoint,
    };

    const attempt = await tryOnce(fbCtx);
    if (isUsable(attempt)) {
      return { response: attempt.response!, usedFallback: fb };
    }
  }

  // All attempts failed — rethrow last transport error, or return last response
  if (primary.response) {
    return { response: primary.response, usedFallback: null };
  }
  throw primary.error ?? new Error('No upstream attempt succeeded');
}

interface Attempt {
  response?: Response;
  error?: Error;
}

async function tryOnce(ctx: CallContext): Promise<Attempt> {
  const timeoutMs = ctx.endpoint.timeout_ms;
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const response = await callUpstream(ctx, ctrl?.signal);
    return { response };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isUsable(a: Attempt): boolean {
  if (a.error) return false;
  if (!a.response) return false;
  const s = a.response.status;
  // Retryable: 429 (rate limit) and 5xx. Client errors (4xx) are "final".
  return !(s === 429 || s >= 500);
}

async function serveCacheHit(
  c: Context,
  ctx: CallContext,
  _key: string,
  cached: string,
  startedAt: number,
) {
  const fullCostMicro = toMicro(ctx.endpoint.price_usd);
  const chargedMicro =
    (fullCostMicro * BigInt(100 - CACHE_DISCOUNT_PCT)) / 100n;

  if (!ctx.x402Paid) {
    await debit({
      userId: ctx.userId,
      amountMicro: chargedMicro,
      apiSlug: ctx.slug,
      meta: { cached: true, endpoint: ctx.endpointKey },
    });
  }

  const latency = Date.now() - startedAt;

  await db.insert(requests).values({
    userId: ctx.userId,
    apiSlug: ctx.slug,
    endpoint: ctx.endpointKey,
    costMicro: chargedMicro,
    markupMicro: chargedMicro, // cache hit = all margin (we didn't pay upstream)
    cacheHit: true,
    latencyMs: latency,
    status: 200,
  });

  return c.body(cached, 200, {
    'content-type': 'application/json',
    'x-axon-cost-usdc': formatUsdc(chargedMicro),
    'x-axon-cache': 'hit',
    'x-axon-latency-ms': String(latency),
  });
}

async function refund(
  ctx: CallContext,
  amountMicro: bigint,
  reason: string,
) {
  await credit({
    userId: ctx.userId,
    amountMicro,
    type: 'refund',
    meta: { api: ctx.slug, endpoint: ctx.endpointKey, reason },
  });
}

async function callUpstream(
  ctx: CallContext,
  signal?: AbortSignal,
): Promise<Response> {
  const { api, endpoint, params, body } = ctx;
  const upstreamKey = upstreamKeyFor(api.slug);
  if (!upstreamKey && api.auth.type !== 'none') {
    const envVar = `UPSTREAM_KEY_${api.slug.toUpperCase().replace(/-/g, '_')}`;
    throw Errors.upstreamMisconfigured(api.slug, envVar);
  }

  // Resolve :var path templates from params (consumes matched params so they
  // don't also get forwarded as query string).
  const { resolvedPath, remaining } = substitutePath(endpoint.path, params);

  const url = new URL(resolvedPath, api.base_url);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'Axon/0.1 (+https://axon.example)',
  };

  // Apply auth
  applyAuth(api.auth, url, headers, upstreamKey);

  // Query params (only the ones not consumed by path template)
  for (const [k, v] of Object.entries(remaining)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const init: RequestInit = {
    method: endpoint.method,
    headers,
  };
  if (body !== undefined && ['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
    init.body = JSON.stringify(body);
  }
  if (signal) init.signal = signal;

  return fetch(url.toString(), init);
}

/**
 * Resolve `:var` style placeholders in the upstream path from the request's
 * query params. Matched params are consumed so they don't duplicate as
 * query string.
 *
 * Example:
 *   path: /v1/predictions/:id
 *   params: { id: 'abc', timeout: '30' }
 *   → resolvedPath: /v1/predictions/abc, remaining: { timeout: '30' }
 */
function substitutePath(
  path: string,
  params: Record<string, unknown>,
): { resolvedPath: string; remaining: Record<string, unknown> } {
  const remaining = { ...params };
  const resolvedPath = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    const value = remaining[name];
    if (value === undefined || value === null) {
      throw Errors.badRequest(`Missing path parameter '${name}'`);
    }
    delete remaining[name];
    return encodeURIComponent(String(value));
  });
  return { resolvedPath, remaining };
}

function applyAuth(
  auth: AuthType,
  url: URL,
  headers: Record<string, string>,
  key: string | undefined,
) {
  if (!key) return;
  switch (auth.type) {
    case 'header':
      headers[auth.name] = auth.prefix ? `${auth.prefix}${key}` : key;
      break;
    case 'query':
      url.searchParams.set(auth.name, key);
      break;
    case 'bearer':
      headers['authorization'] = `Bearer ${key}`;
      break;
    case 'none':
      break;
  }
}

function formatUsdc(micro: bigint): string {
  const MICRO = 1_000_000n;
  const int = micro / MICRO;
  const frac = micro % MICRO;
  return `${int.toString()}.${frac.toString().padStart(6, '0')}`;
}
