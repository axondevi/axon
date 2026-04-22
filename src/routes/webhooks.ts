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
