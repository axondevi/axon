// Cloudflare Worker — pings Render free-tier services every 2min so
// they never idle long enough to be put to sleep. Replaces the older
// GitHub Actions keepalive (which ran every 10min and was unreliable
// because GitHub's cron drifts 5-15min on the free tier).
//
// Cost: 720 requests/day across 3 targets, well within CF Workers free
// tier (100k requests/day). Cron trigger is also free.

const TARGETS = [
  'https://axon-kedb.onrender.com/health/ready',
  'https://axon-evolution.onrender.com/',
  'https://evolution-api-feirinha.onrender.com/',
];

async function pingOnce(url: string): Promise<{ url: string; status: number; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    // Render cold-start can exceed 60s when the Docker image is large;
    // give it 90s so the first ping after sleep doesn't false-fail.
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 90_000);
    const r = await fetch(url, { signal: ctl.signal, cf: { cacheTtl: 0 } as any });
    clearTimeout(tm);
    return { url, status: r.status, ms: Date.now() - t0 };
  } catch (err) {
    return { url, status: 0, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}

export default {
  // Cron trigger: fired every 2 min by Cloudflare's scheduler.
  async scheduled(_event: ScheduledEvent, _env: unknown, ctx: ExecutionContext): Promise<void> {
    // Run all pings in parallel so a slow target doesn't push the
    // worker past CF's CPU budget. Use waitUntil so the worker stays
    // alive past the scheduled callback's return.
    ctx.waitUntil(
      Promise.all(TARGETS.map(pingOnce)).then((results) => {
        for (const r of results) {
          if (r.error || r.status >= 500) {
            console.error('keepalive_failed', JSON.stringify(r));
          } else {
            console.log('keepalive_ok', JSON.stringify(r));
          }
        }
      }),
    );
  },

  // HTTP fetch handler so you can hit the worker URL manually to
  // verify health (or trigger an immediate ping). GET / returns the
  // ping results inline; anything else 404s.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/') return new Response('not found', { status: 404 });
    const results = await Promise.all(TARGETS.map(pingOnce));
    return Response.json({ ok: true, ts: new Date().toISOString(), results });
  },
} satisfies ExportedHandler;
