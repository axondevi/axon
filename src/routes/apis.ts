import { Hono } from 'hono';
import { listApis, getApi } from '~/registry/apis';
import { Errors } from '~/lib/errors';

const app = new Hono();

// ─── GET /v1/apis ─────────────────────────────────────
app.get('/', (c) => {
  const apis = listApis().map((a) => ({
    slug: a.slug,
    provider: a.provider,
    category: a.category,
    description: a.description,
    homepage: a.homepage,
    endpoints: Object.keys(a.endpoints),
  }));
  return c.json({ data: apis, count: apis.length });
});

// ─── GET /v1/apis/:slug ───────────────────────────────
app.get('/:slug', (c) => {
  const slug = c.req.param('slug');
  const api = getApi(slug);
  if (!api) throw Errors.notFound(`API '${slug}'`);

  const endpoints = Object.entries(api.endpoints).map(([key, ep]) => ({
    key,
    method: ep.method,
    path: ep.path,
    price_usd: ep.price_usd,
    markup_pct: ep.markup_pct,
    cache_ttl: ep.cache_ttl,
    effective_price_usd: ep.price_usd * (1 + ep.markup_pct / 100),
    cached_price_usd: ep.price_usd * 0.5,
  }));

  return c.json({
    slug: api.slug,
    provider: api.provider,
    category: api.category,
    description: api.description,
    homepage: api.homepage,
    endpoints,
  });
});

export default app;
