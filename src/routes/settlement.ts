import { Hono } from 'hono';
import { adminAuth } from '~/auth/middleware';
import { desc, eq } from 'drizzle-orm';
import { db } from '~/db';
import { settlements } from '~/db/schema';
import { settleAll, yesterdayUTC, markPaid } from '~/settlement';
import { fromMicro } from '~/wallet/service';
import { Errors } from '~/lib/errors';

const app = new Hono();

// ─── GET /v1/admin/settlements ────────────────────────
app.get('/', adminAuth, async (c) => {
  const status = c.req.query('status');
  const rows = status
    ? await db
        .select()
        .from(settlements)
        .where(eq(settlements.status, status))
        .orderBy(desc(settlements.periodEnd))
        .limit(200)
    : await db
        .select()
        .from(settlements)
        .orderBy(desc(settlements.periodEnd))
        .limit(200);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      api_slug: r.apiSlug,
      period_start: r.periodStart,
      period_end: r.periodEnd,
      request_count: r.requestCount,
      owed_usdc: fromMicro(r.owedMicro),
      status: r.status,
      paid_at: r.paidAt,
      paid_ref: r.paidRef,
    })),
  });
});

// ─── POST /v1/admin/settlements/run ───────────────────
// Trigger a settlement run for yesterday (or a custom period via body).
app.post('/run', adminAuth, async (c) => {
  let period = yesterdayUTC();
  try {
    const body = await c.req.json<{ start?: string; end?: string }>();
    if (body?.start && body?.end) {
      period = { start: new Date(body.start), end: new Date(body.end) };
    }
  } catch {
    // no body → yesterday
  }
  const results = await settleAll(period);
  return c.json({
    ok: true,
    period,
    results: results.map((r) => ({
      ...r,
      owedMicro: r.owedMicro.toString(),
    })),
  });
});

// ─── POST /v1/admin/settlements/:id/paid ──────────────
app.post('/:id/paid', adminAuth, async (c) => {
  const id = c.req.param('id')!;
  const { paid_ref } = await c.req.json<{ paid_ref: string }>();
  if (!paid_ref) throw Errors.badRequest('paid_ref is required');
  await markPaid(id, paid_ref);
  return c.json({ ok: true });
});

export default app;
