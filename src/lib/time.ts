/**
 * UTC day key in `YYYY-MM-DD` form. Used as part of Redis keys for
 * per-day counters (agent daily budget, signup rate-limit windows,
 * cache TTL buckets) so the bucket rolls automatically at midnight UTC.
 */
export function utcDayKey(date?: Date): string {
  const d = date ?? new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
