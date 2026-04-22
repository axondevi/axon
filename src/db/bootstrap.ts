/**
 * Idempotent DB bootstrap — ensures required system rows exist.
 *
 * Runs at server startup. Creates the "x402 anonymous" user used to log
 * requests paid directly on-chain (no authed wallet).
 */
import { sql } from 'drizzle-orm';
import { db } from './index';
import { users, wallets } from './schema';

/** Fixed UUID for the synthetic user that represents all x402-native calls. */
export const X402_ANON_USER_ID = '00000000-0000-0000-0000-000000000000';

export async function ensureSystemRows() {
  // INSERT ... ON CONFLICT DO NOTHING — cheap and idempotent.
  await db
    .insert(users)
    .values({
      id: X402_ANON_USER_ID,
      email: 'x402-anonymous@axon.system',
      apiKeyHash: 'x402-anonymous',
      tier: 'free',
    })
    .onConflictDoNothing();

  await db
    .insert(wallets)
    .values({
      userId: X402_ANON_USER_ID,
      address: '0x0000000000000000000000000000000000000001',
      balanceMicro: 0n,
      reservedMicro: 0n,
    })
    .onConflictDoNothing();

  // Touch the row so timestamps refresh if someone queries health.
  await db.execute(sql`SELECT 1`);
}
