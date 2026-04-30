/**
 * Unit tests for the sent-ids cache used by WhatsApp human-handoff detection.
 */
import { test, expect, beforeEach } from 'bun:test';
import { recordSentId, isSentByUs, _resetForTests, _size } from '~/whatsapp/sent-ids';

beforeEach(() => _resetForTests());

test('records and retrieves a known ID', () => {
  recordSentId('msg_1');
  expect(isSentByUs('msg_1')).toBe(true);
});

test('unknown ID returns false', () => {
  expect(isSentByUs('not_seen')).toBe(false);
});

test('empty/null IDs are no-ops', () => {
  recordSentId(undefined);
  recordSentId('');
  recordSentId(null);
  expect(_size()).toBe(0);
  expect(isSentByUs(undefined)).toBe(false);
  expect(isSentByUs('')).toBe(false);
});

test('expired entries are evicted on read', async () => {
  // Force-insert an expired entry by manipulating Date.now via a wrapper.
  // Simpler: use the public API and time-travel via Date.now mock.
  const realNow = Date.now;
  let now = 1_000_000_000;
  Date.now = () => now;
  try {
    recordSentId('soon_to_expire');
    expect(isSentByUs('soon_to_expire')).toBe(true);
    now += 6 * 60 * 1000;  // 6 minutes — TTL is 5min
    expect(isSentByUs('soon_to_expire')).toBe(false);
  } finally {
    Date.now = realNow;
  }
});

test('size cap prevents unbounded growth', () => {
  for (let i = 0; i < 6000; i++) recordSentId(`id_${i}`);
  // After GC, size should be at or under MAX_ENTRIES (5000)
  expect(_size()).toBeLessThanOrEqual(5000);
});
