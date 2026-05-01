import { Hono } from 'hono';
import { getBalance, fromMicro, toMicro, credit } from '~/wallet/service';
import { adminAuth } from '~/auth/middleware';
import { db } from '~/db';
import { transactions, users, wallets } from '~/db/schema';
import { eq, desc } from 'drizzle-orm';
import { generateApiKey, hashApiKey } from '~/lib/crypto';
import { Errors } from '~/lib/errors';
import { getWalletProvider } from '~/wallet/providers';

const app = new Hono();

// ─── GET /v1/wallet/balance ───────────────────────────
app.get('/balance', async (c) => {
  const user = c.get('user') as { id: string };
  const bal = await getBalance(user.id);
  return c.json({
    address: bal.address,
    balance_usdc: fromMicro(bal.balanceMicro),
    reserved_usdc: fromMicro(bal.reservedMicro),
    available_usdc: fromMicro(bal.availableMicro),
  });
});

// ─── GET /v1/wallet/transactions ──────────────────────
app.get('/transactions', async (c) => {
  const user = c.get('user') as { id: string };
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.userId, user.id))
    .orderBy(desc(transactions.createdAt))
    .limit(limit);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      type: r.type,
      amount_usdc: fromMicro(r.amountMicro),
      api_slug: r.apiSlug,
      onchain_tx: r.onchainTx,
      created_at: r.createdAt,
      meta: r.meta,
    })),
  });
});

// ─── POST /v1/wallet/deposit-intent ───────────────────
// Returns the deposit address + amount. Client sends USDC on Base.
app.post('/deposit-intent', async (c) => {
  const user = c.get('user') as { id: string };
  const bal = await getBalance(user.id);
  return c.json({
    chain: 'base',
    asset: 'USDC',
    asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    deposit_address: bal.address,
    note: 'Send USDC on Base. Credits appear within 1 block confirmation.',
  });
});

// ─── Admin: create user (returns plaintext API key once) ──
export const admin = new Hono();

admin.post('/users', adminAuth, async (c) => {
  const { email } = await c.req.json<{ email?: string }>();
  const rawKey = generateApiKey();
  const [user] = await db
    .insert(users)
    .values({
      email: email ?? null,
      apiKeyHash: hashApiKey(rawKey),
      tier: 'free',
    })
    .returning();

  const provider = getWalletProvider();
  const deposit = await provider.createUserWallet(user.id);

  // The provider's contract is "serializedBackup is already opaque/encrypted
  // by the provider when it contains key material" (see CDPWalletProviderReal).
  // We store as-is in meta — wrapping in encrypt() again is just noise and
  // there's no key rotation contract that benefits from it.
  const walletMeta = deposit.serializedBackup
    ? { cdp_wallet_id: deposit.walletId, backup_enc: deposit.serializedBackup }
    : null;

  await db.insert(wallets).values({
    userId: user.id,
    address: deposit.address.toLowerCase(),
    balanceMicro: toMicro('5'), // $5 signup bonus
  });

  if (walletMeta) {
    await db.insert(transactions).values({
      userId: user.id,
      type: 'bonus',
      amountMicro: 0n,
      meta: { event: 'wallet_provisioned', ...walletMeta },
    });
  }

  await db.insert(transactions).values({
    userId: user.id,
    type: 'bonus',
    amountMicro: toMicro('5'),
    meta: { reason: 'signup_bonus' },
  });

  return c.json({
    user_id: user.id,
    api_key: rawKey,
    deposit_address: deposit.address,
    wallet_provider: provider.name,
    balance_usdc: '5.000000',
    warning: 'Save the API key now. It cannot be retrieved later.',
  });
});

admin.post('/credit', adminAuth, async (c) => {
  const { user_id, amount_usdc, onchain_tx } = await c.req.json<{
    user_id: string;
    amount_usdc: string;
    onchain_tx?: string;
  }>();
  if (!user_id || !amount_usdc) throw Errors.badRequest('user_id and amount_usdc required');
  await credit({
    userId: user_id,
    amountMicro: toMicro(amount_usdc),
    type: 'deposit',
    onchainTx: onchain_tx,
  });
  return c.json({ ok: true });
});

export default app;
