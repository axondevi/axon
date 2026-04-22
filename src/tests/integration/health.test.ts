import { describe, expect, it } from 'bun:test';
import { importApp } from './harness';

describe('integration: health endpoints', () => {
  it('GET / returns ok', async () => {
    const app = await importApp();
    const res = await app.fetch(new Request('http://local/'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; status: string };
    expect(body.name).toBe('axon');
    expect(body.status).toBe('ok');
  });

  it('GET /health returns ok', async () => {
    const app = await importApp();
    const res = await app.fetch(new Request('http://local/health'));
    expect(res.status).toBe(200);
  });

  it('includes x-request-id header', async () => {
    const app = await importApp();
    const res = await app.fetch(new Request('http://local/health'));
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('respects incoming x-request-id', async () => {
    const app = await importApp();
    const res = await app.fetch(
      new Request('http://local/health', {
        headers: { 'x-request-id': 'trace-abc-123' },
      }),
    );
    expect(res.headers.get('x-request-id')).toBe('trace-abc-123');
  });

  it('generates a new id if incoming is malformed', async () => {
    const app = await importApp();
    const res = await app.fetch(
      new Request('http://local/health', {
        headers: { 'x-request-id': 'has spaces and 💩' },
      }),
    );
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).not.toBe('has spaces and 💩');
  });
});

describe('integration: auth', () => {
  it('GET /v1/wallet/balance without key → 401', async () => {
    const app = await importApp();
    const res = await app.fetch(new Request('http://local/v1/wallet/balance'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('GET /v1/wallet/balance with bad key → 401', async () => {
    const app = await importApp();
    const res = await app.fetch(
      new Request('http://local/v1/wallet/balance', {
        headers: { 'x-api-key': 'ax_live_invalidkey' },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('integration: not found', () => {
  it('unknown route → 404', async () => {
    const app = await importApp();
    const res = await app.fetch(new Request('http://local/nonexistent'));
    expect(res.status).toBe(404);
  });
});

describe('integration: public catalog', () => {
  it('GET /v1/apis returns catalog (no auth needed)', async () => {
    const app = await importApp();
    const res = await app.fetch(new Request('http://local/v1/apis'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; count: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.count).toBe('number');
  });

  it('GET /v1/apis/:slug returns details for a known slug', async () => {
    const app = await importApp();
    const res = await app.fetch(new Request('http://local/v1/apis/openai'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; endpoints: unknown[] };
    expect(body.slug).toBe('openai');
    expect(Array.isArray(body.endpoints)).toBe(true);
  });

  it('GET /v1/apis/:slug for unknown slug → 404', async () => {
    const app = await importApp();
    const res = await app.fetch(
      new Request('http://local/v1/apis/doesnotexist'),
    );
    expect(res.status).toBe(404);
  });
});

describe('integration: admin auth', () => {
  it('POST /v1/admin/users without admin key → 403', async () => {
    const app = await importApp();
    const res = await app.fetch(
      new Request('http://local/v1/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'x@y.z' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('POST /v1/admin/users with bad admin key → 403', async () => {
    const app = await importApp();
    const res = await app.fetch(
      new Request('http://local/v1/admin/users', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-key': 'wrongkey',
        },
        body: JSON.stringify({ email: 'x@y.z' }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
