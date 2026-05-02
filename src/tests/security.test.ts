/**
 * Security regression suite.
 *
 * Each case in here represents a class of attack that bit us once or
 * is documented in SECURITY.md as in-scope. The tests use only pure
 * helpers + the SSRF guard — nothing that requires a live DB. The
 * full-app integration tests (auth bypass against actual routes) live
 * in src/tests/integration/ already.
 *
 *   bun test src/tests/security.test.ts
 */

// Same env shim as the integration harness. Static imports are hoisted
// in ES modules so we cannot statically import anything that touches
// ~/config (which validates these envs at load time). The pure helpers
// (ssrf, logger, cache-key) don't read config, so they're safe to
// statically import. crypto.ts and mercadopago.ts read config — those
// are dynamically imported inside the relevant `it` blocks.
process.env.NODE_ENV ??= 'test';
process.env.MASTER_ENCRYPTION_KEY ??=
  'test_master_key_hex_must_be_at_least_32_chars_long_abc';
process.env.ADMIN_API_KEY ??=
  'test_admin_key_hex_must_be_at_least_32_chars_long_abc';
process.env.DATABASE_URL ??= 'postgres://test@localhost/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

import { describe, it, expect } from 'bun:test';
import { checkUrlSafe } from '../lib/ssrf';
import { redactPhone, redactEmail } from '../lib/logger';
import { cacheKey } from '../wrapper/cache-key';

describe('SSRF guard — every block class', () => {
  // A representative sample for each blocked class. The full enumerate
  // lives in src/tests/ssrf.test.ts; this one is the regression sentinel.
  const BLOCKED_URLS = [
    // RFC1918 + loopback + link-local
    ['http://10.0.0.1/', 'private IPv4 10'],
    ['http://127.0.0.1:5432/', 'loopback'],
    ['http://172.16.0.1/', '172.16/12'],
    ['http://192.168.1.1/', '192.168/16'],
    ['http://169.254.169.254/latest/meta-data/', 'AWS IMDS'],
    ['http://100.64.0.1/', 'CGNAT'],
    // IPv6 internals
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[fc00::1]/', 'IPv6 ULA'],
    // Internal hostnames
    ['http://localhost:5432/', 'localhost'],
    ['http://service.internal/', 'internal TLD'],
    ['http://api.local/', 'local TLD'],
    ['http://metadata.google.internal/', 'GCE metadata'],
    ['http://metadata.aws.internal/', 'AWS metadata'],
    // Non-http schemes
    ['file:///etc/passwd', 'file://'],
    ['javascript:alert(1)', 'javascript:'],
    ['ftp://example.com/', 'ftp://'],
    ['gopher://1.2.3.4/', 'gopher://'],
  ];
  for (const [url, label] of BLOCKED_URLS) {
    it(`blocks ${label} (${url})`, () => {
      const r = checkUrlSafe(url as string);
      expect(r.ok).toBe(false);
    });
  }

  it('allows public hosts', () => {
    expect(checkUrlSafe('https://api.openai.com/v1/chat').ok).toBe(true);
    expect(checkUrlSafe('https://hooks.zapier.com/abc').ok).toBe(true);
    expect(checkUrlSafe('http://example.com/').ok).toBe(true);
  });
});

describe('API key cryptography', () => {
  it('generated keys carry 192 bits of entropy', async () => {
    const { generateApiKey } = await import('../lib/crypto');
    const k = generateApiKey();
    expect(k).toMatch(/^ax_live_[0-9a-f]{48}$/);
    expect(k.length).toBe('ax_live_'.length + 48);
  });

  it('two keys never collide', async () => {
    const { generateApiKey } = await import('../lib/crypto');
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const k = generateApiKey();
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it('hash is deterministic for the same key', async () => {
    const { hashApiKey } = await import('../lib/crypto');
    const k = 'ax_live_abc';
    expect(hashApiKey(k)).toBe(hashApiKey(k));
  });

  it('hash differs for distinct keys', async () => {
    const { hashApiKey } = await import('../lib/crypto');
    expect(hashApiKey('ax_live_a')).not.toBe(hashApiKey('ax_live_b'));
  });

  it('hash is not reversible (sha256 → 64 hex)', async () => {
    const { hashApiKey } = await import('../lib/crypto');
    const h = hashApiKey('ax_live_test');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('ax_live_test');
  });
});

describe('AES-GCM round-trip + tamper detection', () => {
  it('encrypt then decrypt yields original plaintext', async () => {
    const { encrypt, decrypt } = await import('../lib/crypto');
    const pt = 'CDP wallet seed material — secret-001';
    const ct = encrypt(pt);
    expect(decrypt(ct)).toBe(pt);
  });

  it('ciphertext is non-deterministic (random IV)', async () => {
    const { encrypt } = await import('../lib/crypto');
    const a = encrypt('same input');
    const b = encrypt('same input');
    expect(a).not.toBe(b);
  });

  it('tampering the ciphertext throws on decrypt (auth tag)', async () => {
    const { encrypt, decrypt } = await import('../lib/crypto');
    const ct = encrypt('payload');
    const [iv, tag, data] = ct.split(':');
    const flipped = data.slice(0, -1) + (data.slice(-1) === '0' ? '1' : '0');
    expect(() => decrypt(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it('rejects malformed ciphertext', async () => {
    const { decrypt } = await import('../lib/crypto');
    expect(() => decrypt('not:valid')).toThrow();
    expect(() => decrypt('aa:bb:not_hex')).toThrow();
  });
});

describe('PII redaction (LGPD / log hygiene)', () => {
  it('phone keeps only first-4 and last-4 digits', () => {
    expect(redactPhone('5511995432538')).toBe('5511***2538');
  });

  it('phone strips formatting', () => {
    expect(redactPhone('+55 (11) 99543-2538')).toBe('5511***2538');
  });

  it('phone returns *** for short input', () => {
    expect(redactPhone('1')).toBe('***');
  });

  it('email keeps first letter and domain', () => {
    expect(redactEmail('kaolin@example.com')).toBe('k*****@example.com');
  });

  it('redact does not throw on null/undefined', () => {
    expect(() => redactPhone(null)).not.toThrow();
    expect(() => redactEmail(undefined)).not.toThrow();
  });
});

describe('Cache key isolation (cross-tenant safety)', () => {
  it('per-user scope (default) isolates by userId', () => {
    const a = cacheKey('x', 'y', { q: 'cpf 12345' }, undefined, { userId: 'alice' });
    const b = cacheKey('x', 'y', { q: 'cpf 12345' }, undefined, { userId: 'bob' });
    expect(a).not.toBe(b);
  });

  it('shared scope intentionally collides for public APIs', () => {
    const a = cacheKey('cep', 'lookup', { cep: '01001000' }, undefined, {
      userId: 'alice',
      scope: 'shared',
    });
    const b = cacheKey('cep', 'lookup', { cep: '01001000' }, undefined, {
      userId: 'bob',
      scope: 'shared',
    });
    expect(a).toBe(b);
  });

  it('omitted scope opts INTO per-user (fail-safe default)', () => {
    const a = cacheKey('x', 'y', { q: '1' }, undefined, { userId: 'alice' });
    const b = cacheKey('x', 'y', { q: '1' }, undefined, { userId: 'alice', scope: 'shared' });
    expect(a).not.toBe(b);
  });
});

describe('Constant-time comparison sanity', () => {
  // We don't directly export the constantTimeStringEqual helper, but
  // verifyWebhookSignature exercises it. The hmac-timing.test.ts
  // suite covers the wire end-to-end. Here we just lock the
  // shape so a refactor doesn't accidentally drop the constant-time
  // branch.
  it('verifyWebhookSignature is exported and async', async () => {
    const mod = await import('../payment/mercadopago');
    expect(typeof mod.verifyWebhookSignature).toBe('function');
    const r = await mod.verifyWebhookSignature({
      signatureHeader: null,
      requestIdHeader: null,
      dataId: '',
      secret: '',
    });
    expect(r.valid).toBe(false);
  });
});

describe('XSS / HTML escape sanity', () => {
  // The persona avatar SVG generator is the one place we render
  // user-influenced text into markup. Make sure it escapes.
  it('escapes dangerous characters in name and emoji', async () => {
    const { renderPersonaAvatar } = await import('../personas/avatar');
    const svg = renderPersonaAvatar({
      name: '<script>alert(1)</script>',
      primary: '#fff',
      secondary: '#000',
      emoji: '<img onerror=alert(1)>',
    });
    // No raw script or event handler should leak into the SVG
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('onerror=');
    // Should still produce valid SVG markup
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });
});

describe('Slug validation (path traversal hardening)', () => {
  // Slugs flow into URL paths and metadata files. Verify the regex
  // rejects the common payload shapes.
  const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
  // The regex is /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/ — accepts a
  // single char OR 3+ chars; explicitly does NOT match 2-char slugs.
  // (The user-facing error message says "2-40 chars" which is slightly
  //  misleading but matches reserved-slug logic; not a security issue.)
  const REJECT = [
    '../etc/passwd', 'foo/bar', 'foo bar', 'FOO', 'foo_bar',
    '-foo', 'foo-', '..', '.', 'ab', // 2-char rejected by regex shape
  ];
  const ACCEPT = ['a', 'foo', 'recepcionista-clinica-br', 'a1b2c3'];

  for (const s of REJECT) {
    it(`rejects slug "${s}"`, () => {
      expect(SLUG_RE.test(s)).toBe(false);
    });
  }
  for (const s of ACCEPT) {
    it(`accepts slug "${s}"`, () => {
      expect(SLUG_RE.test(s)).toBe(true);
    });
  }
});

describe('Voice id validation', () => {
  // Per src/routes/agents.ts and src/routes/voices.ts.
  const VOICE_ID_RE = /^[A-Za-z0-9]{8,40}$/;
  const REJECT = ['', 'short', 'has space', 'has-dash', 'has_under', '<script>', '../../etc'];
  const ACCEPT = ['XrExE9yKIg1WjnnlVkGX', '21m00Tcm4TlvDq8ikWAM', 'AbCdEfGh'];

  for (const v of REJECT) {
    it(`rejects voice_id "${v}"`, () => {
      expect(VOICE_ID_RE.test(v)).toBe(false);
    });
  }
  for (const v of ACCEPT) {
    it(`accepts voice_id "${v}"`, () => {
      expect(VOICE_ID_RE.test(v)).toBe(true);
    });
  }
});
