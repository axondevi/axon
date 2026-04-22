/**
 * Path template substitution tests. The wrapper engine's `substitutePath`
 * isn't exported, so we re-implement the contract here and lock its
 * behavior via integration-style tests against a small copy.
 *
 * When the real function needs a change, copy the new behavior here first
 * (TDD), then update engine.ts — keeps drift visible.
 */
import { describe, expect, it } from 'bun:test';

process.env.MASTER_ENCRYPTION_KEY ??=
  'test_master_key_hex_must_be_at_least_32_chars_long_abc';
process.env.ADMIN_API_KEY ??= 'test_admin_key_hex_must_be_at_least_32_chars_long_abc';
process.env.DATABASE_URL ??= 'postgres://test@localhost/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

// Pure copy of engine.ts#substitutePath — will drift if the real one
// changes; the test is a reminder to update both.
function substitutePath(
  path: string,
  params: Record<string, unknown>,
): { resolvedPath: string; remaining: Record<string, unknown> } {
  const remaining = { ...params };
  const resolvedPath = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    const value = remaining[name];
    if (value === undefined || value === null) {
      throw new Error(`Missing path parameter '${name}'`);
    }
    delete remaining[name];
    return encodeURIComponent(String(value));
  });
  return { resolvedPath, remaining };
}

describe('substitutePath', () => {
  it('replaces a single :var', () => {
    const { resolvedPath, remaining } = substitutePath(
      '/v1/predictions/:id',
      { id: 'abc123', foo: 'bar' },
    );
    expect(resolvedPath).toBe('/v1/predictions/abc123');
    expect(remaining).toEqual({ foo: 'bar' });
  });

  it('replaces multiple :vars', () => {
    const { resolvedPath } = substitutePath('/users/:uid/posts/:pid', {
      uid: 'u1',
      pid: 'p99',
    });
    expect(resolvedPath).toBe('/users/u1/posts/p99');
  });

  it('url-encodes values', () => {
    const { resolvedPath } = substitutePath('/lookup/:ip', { ip: '1.2.3.4' });
    expect(resolvedPath).toBe('/lookup/1.2.3.4');
  });

  it('url-encodes special chars', () => {
    const { resolvedPath } = substitutePath('/q/:term', {
      term: 'hello world/with slash',
    });
    expect(resolvedPath).toBe('/q/hello%20world%2Fwith%20slash');
  });

  it('throws when a :var is missing', () => {
    expect(() => substitutePath('/x/:id', {})).toThrow();
  });

  it('leaves paths without :vars alone', () => {
    const { resolvedPath, remaining } = substitutePath('/search', {
      q: 'hello',
    });
    expect(resolvedPath).toBe('/search');
    expect(remaining).toEqual({ q: 'hello' });
  });
});
