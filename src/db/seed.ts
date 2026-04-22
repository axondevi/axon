/**
 * Creates a demo user with $25 pre-funded wallet for local dev / smoke tests.
 * Run via: `bun run seed`
 *
 * Output:
 *   DEMO_API_KEY=ax_live_xxxxx
 *   DEMO_DEPOSIT_ADDRESS=0x…
 *
 * Copy the API key and hit the server:
 *   curl http://localhost:3000/v1/wallet/balance -H "x-api-key: ax_live_xxxxx"
 */
import { db } from './index';
import { users, wallets, transactions } from './schema';
import { generateApiKey, hashApiKey } from '~/lib/crypto';
import { toMicro } from '~/wallet/service';
import { getWalletProvider } from '~/wallet/providers';
import { eq } from 'drizzle-orm';

async function main() {
  const email = 'demo@axon.local';

  // Idempotent: re-run deletes and recreates the demo user
  await db.delete(users).where(eq(users.email, email));

  const rawKey = generateApiKey();
  const [user] = await db
    .insert(users)
    .values({
      email,
      apiKeyHash: hashApiKey(rawKey),
      tier: 'pro',
    })
    .returning();

  const { address: depositAddress } = await getWalletProvider().createUserWallet(
    user.id,
  );

  await db.insert(wallets).values({
    userId: user.id,
    address: depositAddress.toLowerCase(),
    balanceMicro: toMicro('25'),
  });

  await db.insert(transactions).values({
    userId: user.id,
    type: 'bonus',
    amountMicro: toMicro('25'),
    meta: { reason: 'seed_demo_user' },
  });

  console.log('─'.repeat(60));
  console.log('Demo user created.');
  console.log('');
  console.log(`DEMO_USER_ID=${user.id}`);
  console.log(`DEMO_API_KEY=${rawKey}`);
  console.log(`DEMO_DEPOSIT_ADDRESS=${depositAddress}`);
  console.log(`DEMO_BALANCE_USDC=25.000000`);
  console.log('─'.repeat(60));
  console.log('');
  console.log('Smoke test:');
  console.log(`  curl http://localhost:3000/v1/wallet/balance -H "x-api-key: ${rawKey}"`);
  console.log('');

  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
