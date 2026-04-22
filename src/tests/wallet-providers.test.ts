import { describe, expect, it } from 'bun:test';

process.env.MASTER_ENCRYPTION_KEY ??=
  'test_master_key_hex_must_be_at_least_32_chars_long_abc';
process.env.ADMIN_API_KEY ??= 'test_admin_key_hex_must_be_at_least_32_chars_long_abc';
process.env.DATABASE_URL ??= 'postgres://test@localhost/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { PlaceholderWalletProvider } = await import('../wallet/providers');

describe('PlaceholderWalletProvider', () => {
  const provider = new PlaceholderWalletProvider();

  it('name is "placeholder"', () => {
    expect(provider.name).toBe('placeholder');
  });

  it('returns a deterministic 0x-prefixed 40-hex address', async () => {
    const userId = 'a1b2c3d4-e5f6-7890-abcd-1234567890ab';
    const res = await provider.createUserWallet(userId);
    expect(res.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('is deterministic for the same user', async () => {
    const userId = 'deadbeef-dead-beef-dead-beefdeadbeef';
    const a = await provider.createUserWallet(userId);
    const b = await provider.createUserWallet(userId);
    expect(a.address).toBe(b.address);
  });

  it('differs across users', async () => {
    const a = await provider.createUserWallet('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    const b = await provider.createUserWallet('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(a.address).not.toBe(b.address);
  });

  it('does not return a backup blob (nothing to back up)', async () => {
    const res = await provider.createUserWallet('11111111-1111-1111-1111-111111111111');
    expect(res.serializedBackup).toBeUndefined();
  });
});
