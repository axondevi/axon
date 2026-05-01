import { createHash } from 'node:crypto';

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`)
    .join(',')}}`;
}

/**
 * Per-tenant cache key.
 *
 * The previous implementation hashed only `(params, body)`, so two users
 * making the same call shared the same cached response. That's safe for
 * deterministic public endpoints (a CEP lookup, a holiday list), but it
 * leaks information for endpoints whose response varies by the caller
 * (search history, account-scoped queries, anything where the body
 * happens to contain a name/email).
 *
 * Caller passes `scope: 'shared' | 'per_user'`:
 *   - shared:   global LRU, no userId in the key — use only for endpoints
 *               you've vetted as truly public/idempotent.
 *   - per_user: includes userId in the hash so caches don't cross tenants.
 *
 * Default is per_user (fail-safe). Wrapper engine flips to shared only
 * when the registry entry explicitly opts in via cache_scope='shared'.
 */
export function cacheKey(
  slug: string,
  endpointKey: string,
  params: Record<string, unknown>,
  body?: unknown,
  opts?: { userId?: string; scope?: 'shared' | 'per_user' },
): string {
  const scope = opts?.scope ?? 'per_user';
  const userKey = scope === 'per_user' ? (opts?.userId ?? 'anon') : 'shared';
  const payload = stableStringify({ scope, userKey, params, body });
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `axon:cache:${slug}:${endpointKey}:${hash}`;
}
