/**
 * On-chain deposit watcher.
 *
 * STUB: In production, wire this to a webhook from Coinbase CDP, Alchemy,
 * or a self-run Base RPC that calls `notifyDeposit()` when a USDC transfer
 * to a user's deposit address is seen.
 *
 * For MVP / local dev, expose an admin endpoint that credits a wallet
 * manually — see src/routes/wallet.ts (POST /v1/admin/credit).
 */

import { credit, toMicro } from './service';

export async function notifyDeposit(params: {
  userId: string;
  amountUsdc: number | string;
  onchainTx: string;
}) {
  const { userId, amountUsdc, onchainTx } = params;
  await credit({
    userId,
    amountMicro: toMicro(amountUsdc),
    type: 'deposit',
    onchainTx,
  });
}
