import { describe, expect, it } from 'bun:test';

// Avoid importing ~/config at test-load time — it hard-fails on missing env.
// Set the minimum required envs before importing crypto.
process.env.MASTER_ENCRYPTION_KEY ??=
  'test_master_key_hex_must_be_at_least_32_chars_long_abc';
process.env.ADMIN_API_KEY ??= 'test_admin_key_hex_must_be_at_least_32_chars_long_abc';
process.env.DATABASE_URL ??= 'postgres://test@localhost/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { encrypt, decrypt, hashApiKey, generateApiKey } = await import(
  '../lib/crypto'
);

describe('crypto', () => {
  it('encrypt / decrypt round-trips', () => {
    const plain = 'sk-upstream-secret-abc123';
    const enc = encrypt(plain);
    expect(enc).not.toBe(plain);
    expect(enc.split(':')).toHaveLength(3);
    expect(decrypt(enc)).toBe(plain);
  });

  it('encrypt output differs each call (random IV)', () => {
    const plain = 'same-input-every-time';
    const a = encrypt(plain);
    const b = encrypt(plain);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(plain);
    expect(decrypt(b)).toBe(plain);
  });

  it('tampered ciphertext fails to decrypt', () => {
    const enc = encrypt('secret');
    const tampered = enc.slice(0, -2) + 'ff';
    expect(() => decrypt(tampered)).toThrow();
  });

  it('hashApiKey is deterministic and non-reversible', () => {
    const key = 'ax_live_abc123';
    const h1 = hashApiKey(key);
    const h2 = hashApiKey(key);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(key);
    expect(h1).toHaveLength(64); // sha256 hex
  });

  it('generateApiKey produces unique ax_live_ prefixed strings', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).toMatch(/^ax_live_[a-f0-9]{48}$/);
    expect(b).toMatch(/^ax_live_[a-f0-9]{48}$/);
    expect(a).not.toBe(b);
  });
});
