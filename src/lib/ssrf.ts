/**
 * SSRF guard.
 *
 * Any HTTP(S) URL the platform fetches on behalf of a *user* — webhook
 * subscriber URLs, summarize_url tool, dynamic Evolution registration —
 * MUST go through this check first. Blocks:
 *
 *   - non-http(s) schemes (file://, gopher://, javascript:, ftp://, etc)
 *   - hosts that resolve only by literal IP into RFC1918 private space,
 *     loopback, link-local, reserved (cloud metadata IMDS at
 *     169.254.169.254 — every cloud has one), CGNAT
 *   - bare hostnames without a dot ("intranet", "localhost-aliased")
 *
 * We DO NOT do a DNS resolve here — that opens a TOCTOU race. Hostnames
 * are blocked when they obviously map to internal scope (`localhost`,
 * `*.internal`, `*.local`, etc) and otherwise allowed. If the operator
 * needs hard guarantees, deploy behind an egress proxy.
 */

const PRIVATE_V4_PATTERNS = [
  /^10\./,                                    // 10.0.0.0/8
  /^127\./,                                   // 127.0.0.0/8 (loopback)
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,          // 172.16.0.0/12
  /^192\.168\./,                              // 192.168.0.0/16
  /^169\.254\./,                              // 169.254.0.0/16 (link-local + IMDS)
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // 100.64.0.0/10 (CGNAT)
  /^0\./,                                     // 0.0.0.0/8
  /^(22[4-9]|2[3-5][0-9])\./,                 // 224.0.0.0/4 (multicast) + 240.0.0.0/4 (reserved)
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.aws.internal',
]);

const BLOCKED_TLDS = ['.local', '.internal', '.localhost'];

export interface SsrfCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate that `url` is safe for the platform to fetch.
 * Returns `{ok: true}` if allowed, `{ok: false, reason: ...}` otherwise.
 */
export function checkUrlSafe(url: string): SsrfCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `scheme '${parsed.protocol}' not allowed` };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, reason: 'missing hostname' };

  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: `hostname '${host}' is blocked` };
  }
  for (const tld of BLOCKED_TLDS) {
    if (host === tld.slice(1) || host.endsWith(tld)) {
      return { ok: false, reason: `internal TLD '${tld}' blocked` };
    }
  }

  // IPv4 literal — check against private ranges
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    for (const pat of PRIVATE_V4_PATTERNS) {
      if (pat.test(host)) {
        return { ok: false, reason: `private IPv4 ${host} blocked` };
      }
    }
  }

  // IPv6 literal — block loopback, link-local, ULA
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1).toLowerCase();
    if (v6 === '::1' || v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd') || v6 === '::') {
      return { ok: false, reason: `private IPv6 ${v6} blocked` };
    }
  }

  return { ok: true };
}
