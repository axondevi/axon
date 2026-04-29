/**
 * Deposit webhook — credits a user wallet when USDC lands on their deposit
 * address on Base.
 *
 * Primary integration: Alchemy "Address Activity" webhook.
 * Alternative: roll your own with a Base RPC poller calling /v1/admin/credit.
 *
 * Alchemy sends a POST with `x-alchemy-signature` — HMAC-SHA256 of the raw
 * body using your signing key. We verify that, extract USDC transfers to any
 * known deposit address, and credit the corresponding user.
 */

import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '~/db';
import { wallets, transactions } from '~/db/schema';
import { credit, toMicro } from '~/wallet/service';
import { env } from '~/config';
import { Errors } from '~/lib/errors';
import { log } from '~/lib/logger';

const app = new Hono();

// USDC on Base mainnet (6 decimals)
const USDC_BASE = env.USDC_ADDRESS.toLowerCase();

function verifyAlchemySignature(raw: string, signature: string | undefined): boolean {
  if (!signature || !env.ALCHEMY_WEBHOOK_SIGNING_KEY) return false;
  const computed = createHmac('sha256', env.ALCHEMY_WEBHOOK_SIGNING_KEY)
    .update(raw, 'utf8')
    .digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface AlchemyAddressActivity {
  webhookId: string;
  id: string;
  createdAt: string;
  type: 'ADDRESS_ACTIVITY';
  event: {
    network: string;
    activity: Array<{
      fromAddress: string;
      toAddress: string;
      blockNum: string;
      hash: string;
      value: number;
      asset: string;
      category: 'external' | 'token' | 'internal';
      rawContract: {
        rawValue: string;
        address: string;
        decimals: number;
      };
    }>;
  };
}

app.post('/alchemy', async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header('x-alchemy-signature');

  if (!verifyAlchemySignature(raw, sig)) {
    throw Errors.forbidden();
  }

  const payload = JSON.parse(raw) as AlchemyAddressActivity;
  if (payload.type !== 'ADDRESS_ACTIVITY') {
    return c.json({ ok: true, ignored: 'not ADDRESS_ACTIVITY' });
  }

  const results: Array<{ tx: string; credited: boolean; reason?: string }> = [];

  for (const act of payload.event.activity) {
    const token = act.rawContract?.address?.toLowerCase();
    if (act.category !== 'token' || token !== USDC_BASE) {
      results.push({ tx: act.hash, credited: false, reason: 'not_usdc' });
      continue;
    }

    // Idempotency: skip if this onchain tx is already recorded
    const existing = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.onchainTx, act.hash))
      .limit(1);
    if (existing.length > 0) {
      results.push({ tx: act.hash, credited: false, reason: 'duplicate' });
      continue;
    }

    // Map deposit address → user
    const to = act.toAddress?.toLowerCase();
    const [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.address, to))
      .limit(1);
    if (!wallet) {
      results.push({ tx: act.hash, credited: false, reason: 'unknown_address' });
      continue;
    }

    const amountMicro = BigInt(act.rawContract.rawValue); // USDC is already 6-decimals = micro-USDC
    await credit({
      userId: wallet.userId,
      amountMicro,
      type: 'deposit',
      onchainTx: act.hash,
      meta: {
        from: act.fromAddress,
        blockNum: act.blockNum,
        network: payload.event.network,
      },
    });

    results.push({ tx: act.hash, credited: true });
  }

  return c.json({ ok: true, results });
});

/**
 * MercadoPago Pix webhook.
 *
 * Flow:
 *   1. MP fires POST with `?type=payment&data.id=<mp_id>` and a x-signature
 *      header containing HMAC-SHA256 of `id:<id>;request-id:<rid>;ts:<ts>;`.
 *   2. We verify the signature against MP_WEBHOOK_SECRET (defends replay /
 *      spoofing — never trust webhook payload alone).
 *   3. We re-fetch the payment from MP API to get authoritative status.
 *   4. If approved AND we have a matching pix_payments row by external_reference,
 *      credit the user's USDC wallet at the configured FX rate, and flip
 *      the row to status='approved'. Idempotent on mp_payment_id (unique idx).
 *
 * MP retries failed deliveries with exponential backoff for ~24h. We always
 * return 200 once we've recorded the result — non-200 forces them to retry.
 */
app.post('/mercadopago', async (c) => {
  // Lazy imports — keeps the Alchemy-only deploy path from pulling these.
  const { db: dbm } = await import('~/db');
  const { pixPayments } = await import('~/db/schema');
  const { and, eq: eqm } = await import('drizzle-orm');
  const { credit: creditFn, toMicro: toMicroFn } = await import('~/wallet/service');
  const { getPayment, verifyWebhookSignature } = await import('~/payment/mercadopago');

  // MP sends both query (?data.id=) and JSON body. Some webhooks use one or the other.
  const url = new URL(c.req.url);
  const dataId =
    url.searchParams.get('data.id') ||
    url.searchParams.get('id') ||
    '';
  const requestId = c.req.header('x-request-id');
  const sigHeader = c.req.header('x-signature');

  // 1. Verify signature (skip in test mode — env not set)
  const secret = process.env.MP_WEBHOOK_SECRET || '';
  if (secret) {
    const v = await verifyWebhookSignature({
      signatureHeader: sigHeader || null,
      requestIdHeader: requestId || null,
      dataId,
      secret,
    });
    if (!v.valid) {
      // Log but return 200 — MP retries non-200 forever, even on our own bugs.
      // Better to absorb a possibly-spoofed payload than create a retry storm.
      log.warn('mp_signature_invalid', { reason: v.reason });
      return c.json({ ignored: 'signature_invalid' });
    }
  }

  // Body may be empty for some MP notifications. Use whichever id is set.
  const body = await c.req.json().catch(() => ({} as any));
  const resourceId = String(body?.data?.id || dataId || '');
  if (!resourceId) return c.json({ ignored: 'no_resource_id' });

  // 2. Re-fetch from MP — never trust webhook payload alone
  const payment = await getPayment(resourceId);
  if (!payment.ok) {
    log.warn('mp_fetch_failed', { resourceId, error: payment.error });
    return c.json({ ignored: 'fetch_failed' });
  }

  // 3. Find our row by external_reference (we set it = pix_payments.id)
  const externalRef = payment.externalReference;
  if (!externalRef) {
    log.warn('mp_no_external_ref', { mpId: resourceId, status: payment.status });
    return c.json({ ignored: 'no_external_ref' });
  }
  const [row] = await dbm.select().from(pixPayments).where(eqm(pixPayments.id, externalRef)).limit(1);
  if (!row) {
    log.warn('mp_row_not_found', { externalRef, mpId: resourceId });
    return c.json({ ignored: 'row_not_found' });
  }

  // 4. Idempotency: already processed → no-op
  if (row.status === 'approved') {
    return c.json({ ok: true, idempotent: true });
  }

  // 5. Status mapping
  const newStatus = payment.status || 'pending';
  if (newStatus === 'approved' && Number(payment.amountBrl) > 0) {
    // Convert to USDC at configured rate
    const fx = parseFloat(process.env.MP_FX_BRL_PER_USD || '5.4');
    const usdcDecimal = Number(payment.amountBrl) / fx;
    const amountMicro = toMicroFn(usdcDecimal.toFixed(6));

    // Credit wallet (writes ledger row in transactions)
    await creditFn({
      userId: row.userId,
      amountMicro,
      type: 'deposit',
      meta: {
        source: 'pix_mercadopago',
        mp_payment_id: payment.mpId,
        amount_brl: payment.amountBrl,
        fx_rate_brl_per_usd: fx,
        approved_at: payment.approvedAt,
      },
    });

    // Flip our pending row to approved
    await dbm
      .update(pixPayments)
      .set({
        status: 'approved',
        amountUsdcMicro: amountMicro,
        fxRateBrlPerUsd: fx.toFixed(4),
        approvedAt: payment.approvedAt ? new Date(payment.approvedAt) : new Date(),
        updatedAt: new Date(),
      })
      .where(eqm(pixPayments.id, row.id));

    log.info('mp_pix_approved', {
      pixId: row.id,
      userId: row.userId,
      mpId: payment.mpId,
      amountBrl: payment.amountBrl,
      amountUsdc: usdcDecimal.toFixed(6),
    });
    return c.json({ ok: true, status: 'approved' });
  }

  // Non-approved terminal states — record but no credit
  if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(newStatus)) {
    await dbm
      .update(pixPayments)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eqm(pixPayments.id, row.id));
    log.info('mp_pix_terminal', { pixId: row.id, status: newStatus });
    return c.json({ ok: true, status: newStatus });
  }

  // Pending / in_process / authorized — leave the row as-is
  return c.json({ ok: true, status: newStatus, no_action: true });
});

/**
 * Manual deposit webhook (internal / testnet fallback).
 * Useful when you want to credit without Alchemy in the loop.
 * Protect with DEPOSIT_WEBHOOK_TOKEN.
 */
app.post('/manual', async (c) => {
  const token = c.req.header('x-deposit-token');
  if (!env.DEPOSIT_WEBHOOK_TOKEN || token !== env.DEPOSIT_WEBHOOK_TOKEN) {
    throw Errors.forbidden();
  }

  const { address, amount_usdc, onchain_tx } = await c.req.json<{
    address: string;
    amount_usdc: string;
    onchain_tx?: string;
  }>();

  const [wallet] = await db
    .select()
    .from(wallets)
    .where(eq(wallets.address, address.toLowerCase()))
    .limit(1);
  if (!wallet) throw Errors.notFound('Deposit address');

  await credit({
    userId: wallet.userId,
    amountMicro: toMicro(amount_usdc),
    type: 'deposit',
    onchainTx: onchain_tx,
    meta: { source: 'manual_webhook' },
  });

  return c.json({ ok: true, user_id: wallet.userId });
});

export default app;
