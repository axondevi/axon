import { describe, expect, it } from 'bun:test';

process.env.MASTER_ENCRYPTION_KEY ??=
  'test_master_key_hex_must_be_at_least_32_chars_long_abc';
process.env.ADMIN_API_KEY ??= 'test_admin_key_hex_must_be_at_least_32_chars_long_abc';
process.env.DATABASE_URL ??= 'postgres://test@localhost/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { toMicro, fromMicro, MICRO } = await import('../wallet/service');

describe('toMicro / fromMicro', () => {
  it('MICRO is 1e6 as bigint', () => {
    expect(MICRO).toBe(1_000_000n);
  });

  it('converts whole USDC correctly', () => {
    expect(toMicro('1')).toBe(1_000_000n);
    expect(toMicro('25')).toBe(25_000_000n);
    expect(toMicro('0')).toBe(0n);
  });

  it('converts fractional USDC correctly', () => {
    expect(toMicro('1.5')).toBe(1_500_000n);
    expect(toMicro('0.005500')).toBe(5_500n);
    expect(toMicro('0.000001')).toBe(1n); // 1 micro-USDC
  });

  it('truncates beyond 6 decimals', () => {
    expect(toMicro('0.0000001')).toBe(0n); // sub-micro → 0
    expect(toMicro('1.234567890')).toBe(1_234_567n); // 7th+ decimal dropped
  });

  it('round-trips via fromMicro', () => {
    const cases = ['0.005500', '25.000000', '100.123456', '0.000001'];
    for (const c of cases) {
      expect(fromMicro(toMicro(c))).toBe(c);
    }
  });

  it('fromMicro always prints 6 decimals', () => {
    expect(fromMicro(1_000_000n)).toBe('1.000000');
    expect(fromMicro(1n)).toBe('0.000001');
    expect(fromMicro(0n)).toBe('0.000000');
  });

  it('fromMicro handles negative amounts (debits)', () => {
    expect(fromMicro(-1_000n)).toBe('-0.001000');
    expect(fromMicro(-8_800n)).toBe('-0.008800');
    expect(fromMicro(-1_234_567n)).toBe('-1.234567');
    expect(fromMicro(-1n)).toBe('-0.000001');
  });
});
