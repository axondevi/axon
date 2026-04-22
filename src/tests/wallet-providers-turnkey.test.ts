import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

process.env.MASTER_ENCRYPTION_KEY ??=
  'test_master_key_hex_must_be_at_least_32_chars_long_abc';
process.env.ADMIN_API_KEY ??= 'test_admin_key_hex_must_be_at_least_32_chars_long_abc';
process.env.DATABASE_URL ??= 'postgres://test@localhost/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { TurnkeyWalletProviderReal } = await import('../wallet/providers-turnkey');

describe('TurnkeyWalletProviderReal', () => {
  const provider = new TurnkeyWalletProviderReal();

  const originalEnv = {
    pub: process.env.TURNKEY_API_PUBLIC_KEY,
    priv: process.env.TURNKEY_API_PRIVATE_KEY,
    org: process.env.TURNKEY_ORGANIZATION_ID,
  };

  beforeEach(() => {
    delete process.env.TURNKEY_API_PUBLIC_KEY;
    delete process.env.TURNKEY_API_PRIVATE_KEY;
    delete process.env.TURNKEY_ORGANIZATION_ID;
  });

  afterEach(() => {
    if (originalEnv.pub) process.env.TURNKEY_API_PUBLIC_KEY = originalEnv.pub;
    if (originalEnv.priv) process.env.TURNKEY_API_PRIVATE_KEY = originalEnv.priv;
    if (originalEnv.org) process.env.TURNKEY_ORGANIZATION_ID = originalEnv.org;
  });

  it('name is "turnkey"', () => {
    expect(provider.name).toBe('turnkey');
  });

  it('throws a helpful error when SDK is not installed OR creds are missing', async () => {
    // @turnkey/sdk-server is not a declared dep — without env, the provider
    // either fails on import (no SDK) or on the credentials check. Both
    // produce a clear, actionable message rather than a stacktrace.
    await expect(
      provider.createUserWallet('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/Turnkey|@turnkey\/sdk-server/);
  });
});
