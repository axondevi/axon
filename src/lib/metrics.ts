/**
 * Tiny counter helpers backed by Redis.
 *
 *   await bumpCounter('axon_app_errors_total', { code: 'unauthorized', severity: 'warn' });
 *
 * Counters live under `metric:<name>:<labelhash>` and are read by
 * src/routes/metrics.ts when serving /metrics. Keys auto-expire 7 days
 * after the last bump so absent-but-legitimate-zero series don't
 * accumulate indefinitely.
 *
 * Wrapped in try/catch so a Redis hiccup never breaks the calling path.
 */
import { redis } from '~/cache/redis';

const KEY_PREFIX = 'metric:';
const KEY_TTL_SEC = 7 * 24 * 60 * 60;

function labelKey(labels: Record<string, string>): string {
  // Stable serialisation — sorted keys, no JSON quoting noise. Names
  // are restricted to safe chars; values get sanitised at scrape time.
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join('|');
}

export async function bumpCounter(
  name: string,
  labels: Record<string, string> = {},
  delta = 1,
): Promise<void> {
  try {
    const key = `${KEY_PREFIX}${name}:${labelKey(labels)}`;
    await redis.incrby(key, delta);
    redis.expire(key, KEY_TTL_SEC).catch(() => {});
  } catch {
    // best-effort
  }
}

/**
 * Snapshot every metric:* key for the Prometheus exposition layer.
 * Returns rows shaped like:
 *   { name: 'axon_app_errors_total', labels: {code:'unauthorized', severity:'warn'}, value: 14 }
 *
 * Uses SCAN (not KEYS) so a large keyspace doesn't block Redis.
 */
export interface MetricRow {
  name: string;
  labels: Record<string, string>;
  value: number;
}
export async function readAllMetrics(): Promise<MetricRow[]> {
  const out: MetricRow[] = [];
  let cursor = '0';
  try {
    do {
      const [next, batch] = (await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500)) as [string, string[]];
      cursor = next;
      if (batch.length === 0) continue;
      const values = await redis.mget(...batch);
      for (let i = 0; i < batch.length; i++) {
        const k = batch[i];
        const v = Number(values[i] ?? 0);
        if (!Number.isFinite(v)) continue;
        const tail = k.slice(KEY_PREFIX.length);
        // Format: <name>:<k=v|k=v|…>
        const colon = tail.indexOf(':');
        const name = colon < 0 ? tail : tail.slice(0, colon);
        const labelsStr = colon < 0 ? '' : tail.slice(colon + 1);
        const labels: Record<string, string> = {};
        if (labelsStr) {
          for (const pair of labelsStr.split('|')) {
            const eq = pair.indexOf('=');
            if (eq < 0) continue;
            labels[pair.slice(0, eq)] = pair.slice(eq + 1);
          }
        }
        out.push({ name, labels, value: v });
      }
    } while (cursor !== '0');
  } catch {
    // best-effort
  }
  return out;
}
