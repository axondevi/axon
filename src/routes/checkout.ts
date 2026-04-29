/**
 * Pix checkout — owner-authed endpoints.
 *
 *   POST /v1/checkout/pix          → create a new Pix charge, return QR
 *   GET  /v1/checkout/pix/:id      → poll status (used by the dashboard)
 *
 * Companion webhook lives in `src/routes/webhooks.ts` at /v1/webhooks/mercadopago.
 */
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '~/db';
import { pixPayments, users } from '~/db/schema';
import { Errors } from '~/lib/errors';
import { createPixPayment } from '~/payment/mercadopago';
import { fromMicro } from '~/wallet/service';

export const checkoutRoutes = new Hono();

/** Hardcoded fallback FX. Override via env. Updated occasionally — don't trust mid-day swings. */
function fxBrlPerUsd(): number {
  const env = parseFloat(process.env.MP_FX_BRL_PER_USD || '');
  if (Number.isFinite(env) && env > 1 && env < 20) return env;
  return 5.4;
}

/** Min/max enforced server-side (client is hostile). $1 USDC equiv → $1000 USDC equiv. */
const MIN_BRL = 5;
const MAX_BRL = 5000;

checkoutRoutes.post('/pix', async (c) => {
  const user = c.get('user') as { id: string; email: string | null };

  const body = await c.req.json().catch(() => ({} as any));
  const amountBrl = Number(body.amount_brl);
  if (!Number.isFinite(amountBrl) || amountBrl < MIN_BRL || amountBrl > MAX_BRL) {
    return c.json(
      { error: 'bad_request', message: `amount_brl must be between R$${MIN_BRL} and R$${MAX_BRL}` },
      400,
    );
  }

  // Pre-create our row so we have an id to use as MP external_reference.
  // This lets the webhook correlate without a separate lookup table.
  const [row] = await db
    .insert(pixPayments)
    .values({
      userId: user.id,
      mpPaymentId: 'pending',  // placeholder, overwritten below
      amountBrl: amountBrl.toFixed(2),
      status: 'pending',
    })
    .returning();

  // Build webhook URL from this request (so it works on any host without env config).
  const url = new URL(c.req.url);
  const fwdProto = c.req.header('x-forwarded-proto');
  const proto = fwdProto || (url.protocol === 'https:' ? 'https' : 'http');
  const host = c.req.header('x-forwarded-host') || url.host;
  const notificationUrl = `${proto}://${host}/v1/webhooks/mercadopago`;

  const result = await createPixPayment({
    amountBrl,
    externalReference: row.id,
    description: `Axon · Recarga R$${amountBrl.toFixed(2)} (user ${user.id.slice(0, 8)})`,
    payerEmail: user.email || `${user.id}@axon.user`,
    idempotencyKey: row.id,                      // our row.id never repeats
    notificationUrl,
    expiresInMinutes: 30,
  });

  if (!result.ok) {
    // Roll back the placeholder row so we don't leak orphaned pending charges.
    await db.delete(pixPayments).where(eq(pixPayments.id, row.id));
    return c.json({ error: 'mp_create_failed', message: result.error }, 502);
  }

  // Persist QR + correlation. Status stays 'pending' until webhook fires.
  await db
    .update(pixPayments)
    .set({
      mpPaymentId: result.mpId!,
      qrCode: result.qrCode,
      qrCodeBase64: result.qrCodeBase64,
      ticketUrl: result.ticketUrl,
      expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
      updatedAt: new Date(),
    })
    .where(eq(pixPayments.id, row.id));

  const fx = fxBrlPerUsd();
  return c.json({
    id: row.id,
    mp_id: result.mpId,
    amount_brl: amountBrl.toFixed(2),
    estimated_credit_usdc: (amountBrl / fx).toFixed(6),
    fx_rate_brl_per_usd: fx,
    qr_code: result.qrCode,                   // copy-paste pix string
    qr_code_base64: result.qrCodeBase64,      // PNG base64
    ticket_url: result.ticketUrl,
    expires_at: result.expiresAt,
    status: 'pending',
  });
});

checkoutRoutes.get('/pix/:id', async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  const [p] = await db
    .select()
    .from(pixPayments)
    .where(and(eq(pixPayments.id, id), eq(pixPayments.userId, user.id)))
    .limit(1);
  if (!p) throw Errors.notFound('Pix payment');

  return c.json({
    id: p.id,
    mp_id: p.mpPaymentId,
    status: p.status,
    amount_brl: p.amountBrl,
    amount_usdc: p.amountUsdcMicro ? fromMicro(p.amountUsdcMicro) : null,
    qr_code: p.qrCode,
    qr_code_base64: p.qrCodeBase64,
    ticket_url: p.ticketUrl,
    expires_at: p.expiresAt,
    approved_at: p.approvedAt,
    created_at: p.createdAt,
  });
});

/** List recent Pix payments for the dashboard "Recargas recentes" panel. */
checkoutRoutes.get('/pix', async (c) => {
  const user = c.get('user') as { id: string };
  const rows = await db
    .select()
    .from(pixPayments)
    .where(eq(pixPayments.userId, user.id))
    .orderBy(pixPayments.createdAt)
    .limit(20);
  return c.json({
    data: rows.reverse().map((p) => ({
      id: p.id,
      status: p.status,
      amount_brl: p.amountBrl,
      amount_usdc: p.amountUsdcMicro ? fromMicro(p.amountUsdcMicro) : null,
      created_at: p.createdAt,
      approved_at: p.approvedAt,
    })),
  });
});
