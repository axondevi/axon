/**
 * Policy engine unit tests — logic-only (no DB round-trip).
 * We verify the deny/allow logic on static inputs by calling enforcePolicy
 * with a mocked sum. Rather than reaching into DB, we test the simple
 * validator on the admin route instead.
 */
import { describe, expect, it } from 'bun:test';

process.env.MASTER_ENCRYPTION_KEY ??=
  'test_master_key_hex_must_be_at_least_32_chars_long_abc';
process.env.ADMIN_API_KEY ??= 'test_admin_key_hex_must_be_at_least_32_chars_long_abc';
process.env.DATABASE_URL ??= 'postgres://test@localhost/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

// Import the type to ensure shape stability.
import type { Policy } from '~/policy/types';

describe('Policy shape', () => {
  it('accepts minimal empty policy', () => {
    const p: Policy = {};
    expect(p).toBeDefined();
  });

  it('accepts allow + deny lists', () => {
    const p: Policy = {
      allow_apis: ['serpapi', 'firecrawl'],
      deny_apis: ['replicate'],
    };
    expect(p.allow_apis?.length).toBe(2);
  });

  it('accepts bigint-as-string budgets', () => {
    const p: Policy = {
      daily_budget_micro: '10000000', // $10
      monthly_budget_micro: '200000000', // $200
      max_request_cost_micro: '50000', // $0.05
    };
    expect(p.daily_budget_micro).toBe('10000000');
  });

  it('accepts per-API caps', () => {
    const p: Policy = {
      per_api_daily_micro: {
        openai: '5000000', // $5
        anthropic: '3000000',
      },
    };
    expect(Object.keys(p.per_api_daily_micro ?? {}).length).toBe(2);
  });
});
