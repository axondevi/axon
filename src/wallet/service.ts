import { eq, sql } from 'drizzle-orm';
import { db } from '~/db';
import { wallets, transactions } from '~/db/schema';
import { Errors } from '~/lib/errors';

// USDC has 6 decimals. We store everything as bigint "micro-USDC".
export const USDC_DECIMALS = 6;
export const MICRO = 10n ** BigInt(USDC_DECIMALS);

export function toMicro(usdc: number | string): bigint {
  const [int, frac = ''] = String(usdc).split('.');
  const padded = (frac + '000000').slice(0, 6);
  return BigInt(int) * MICRO + BigInt(padded || '0');
}

export function fromMicro(micro: bigint): string {
  const int = micro / MICRO;
  const frac = micro % MICRO;
  return `${int.toString()}.${frac.toString().padStart(6, '0')}`;
}

export async function getBalance(userId: string) {
  const [w] = await db.select().from(wallets).where(eq(wallets.userId, userId));
  if (!w) throw Errors.notFound('Wallet');
  return {
    balanceMicro: w.balanceMicro,
    reservedMicro: w.reservedMicro,
    availableMicro: w.balanceMicro - w.reservedMicro,
    address: w.address,
  };
}

/**
 * Atomically debit a user wallet. Uses a single UPDATE with WHERE on
 * balance to avoid race conditions — if available funds are insufficient,
 * zero rows are updated and we throw.
 */
export async function debit(params: {
  userId: string;
  amountMicro: bigint;
  apiSlug?: string;
  requestId?: string;
  meta?: Record<string, unknown>;
  type?: 'debit' | 'refund';
}) {
  const { userId, amountMicro, apiSlug, requestId, meta } = params;
  const type = params.type ?? 'debit';

  if (amountMicro <= 0n) {
    throw Errors.badRequest('amount must be > 0');
  }

  const result = await db
    .update(wallets)
    .set({
      balanceMicro: sql`${wallets.balanceMicro} - ${amountMicro}`,
      updatedAt: new Date(),
    })
    .where(
      sql`${wallets.userId} = ${userId} AND (${wallets.balanceMicro} - ${wallets.reservedMicro}) >= ${amountMicro}`,
    )
    .returning({ balanceMicro: wallets.balanceMicro });

  if (result.length === 0) {
    const [w] = await db.select().from(wallets).where(eq(wallets.userId, userId));
    throw Errors.insufficientFunds(amountMicro, w?.balanceMicro ?? 0n);
  }

  await db.insert(transactions).values({
    userId,
    type,
    amountMicro: -amountMicro,
    apiSlug,
    requestId,
    meta,
  });

  return { newBalanceMicro: result[0].balanceMicro };
}

export async function credit(params: {
  userId: string;
  amountMicro: bigint;
  type: 'deposit' | 'refund' | 'bonus';
  onchainTx?: string;
  meta?: Record<string, unknown>;
}) {
  const { userId, amountMicro, type, onchainTx, meta } = params;

  const result = await db
    .update(wallets)
    .set({
      balanceMicro: sql`${wallets.balanceMicro} + ${amountMicro}`,
      updatedAt: new Date(),
    })
    .where(eq(wallets.userId, userId))
    .returning({ newBalanceMicro: wallets.balanceMicro });

  await db.insert(transactions).values({
    userId,
    type,
    amountMicro,
    onchainTx,
    meta,
  });

  // Outbound webhooks for notable credits. Dynamic import so the webhook
  // module isn't pulled into test harnesses that don't need it.
  if (result.length > 0) {
    const newBalance = fromMicro(result[0].newBalanceMicro);
    if (type === 'deposit') {
      const { emitWebhook } = await import('~/webhooks/emitter');
      emitWebhook(userId, 'deposit.received', {
        amount_usdc: fromMicro(amountMicro),
        new_balance_usdc: newBalance,
        onchain_tx: onchainTx ?? null,
      });
    }
    if (type === 'refund' && amountMicro > 0n && meta) {
      const { emitWebhook } = await import('~/webhooks/emitter');
      emitWebhook(userId, 'call.refunded', {
        api_slug: String((meta as any).api ?? (meta as any).slug ?? ''),
        endpoint: String((meta as any).endpoint ?? ''),
        amount_refunded_usdc: fromMicro(amountMicro),
        reason: String((meta as any).reason ?? 'unknown'),
      });
    }
  }
}
