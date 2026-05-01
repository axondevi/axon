import { describe, expect, it } from 'bun:test';
import { cacheKey } from '../wrapper/cache-key';

describe('cacheKey', () => {
  it('is deterministic for identical inputs', () => {
    const k1 = cacheKey('serpapi', 'search', { q: 'hello', lang: 'en' });
    const k2 = cacheKey('serpapi', 'search', { q: 'hello', lang: 'en' });
    expect(k1).toBe(k2);
  });

  it('is independent of param insertion order', () => {
    const k1 = cacheKey('x', 'y', { a: 1, b: 2 });
    const k2 = cacheKey('x', 'y', { b: 2, a: 1 });
    expect(k1).toBe(k2);
  });

  it('differs when any param changes', () => {
    const k1 = cacheKey('x', 'y', { q: 'hello' });
    const k2 = cacheKey('x', 'y', { q: 'hello!' });
    expect(k1).not.toBe(k2);
  });

  it('differs by slug and endpoint', () => {
    const k1 = cacheKey('a', 'x', { q: '1' });
    const k2 = cacheKey('b', 'x', { q: '1' });
    const k3 = cacheKey('a', 'y', { q: '1' });
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('includes body when cache_on_body is used', () => {
    const k1 = cacheKey('x', 'y', {}, { text: 'hello' });
    const k2 = cacheKey('x', 'y', {}, { text: 'world' });
    const k3 = cacheKey('x', 'y', {}, undefined);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('produces axon:cache: prefix', () => {
    const k = cacheKey('x', 'y', {});
    expect(k.startsWith('axon:cache:x:y:')).toBe(true);
  });

  it('isolates per-user caches by default (userId-scoped)', () => {
    const a = cacheKey('x', 'y', { q: '1' }, undefined, { userId: 'alice' });
    const b = cacheKey('x', 'y', { q: '1' }, undefined, { userId: 'bob' });
    expect(a).not.toBe(b);
  });

  it('shares the cache across users when scope=shared', () => {
    const a = cacheKey('x', 'y', { q: '1' }, undefined, { userId: 'alice', scope: 'shared' });
    const b = cacheKey('x', 'y', { q: '1' }, undefined, { userId: 'bob', scope: 'shared' });
    expect(a).toBe(b);
  });

  it('does not collide across scopes for the same user', () => {
    const a = cacheKey('x', 'y', { q: '1' }, undefined, { userId: 'alice', scope: 'per_user' });
    const b = cacheKey('x', 'y', { q: '1' }, undefined, { userId: 'alice', scope: 'shared' });
    expect(a).not.toBe(b);
  });
});
