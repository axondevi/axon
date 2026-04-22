import { createHash } from 'node:crypto';

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`)
    .join(',')}}`;
}

export function cacheKey(
  slug: string,
  endpointKey: string,
  params: Record<string, unknown>,
  body?: unknown,
): string {
  const payload = stableStringify({ params, body });
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `axon:cache:${slug}:${endpointKey}:${hash}`;
}
