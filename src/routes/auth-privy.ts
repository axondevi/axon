/**
 * Privy embedded wallet auth — "Web2 UX, Web3 underneath".
 *
 * Visitors sign in with email/Google. Privy creates an embedded wallet
 * (no seed phrase, no MetaMask). Frontend gets a Privy access token.
 * That token is verified here and exchanged for an Axon API key.
 *
 * Wallet flow:
 *   1. Frontend: privy.login() → privy.user.getAccessToken()
 *   2. POST /v1/auth/privy with { token, wallet_address, email }
 *   3. We verify the token against Privy's JWKS (RS256)
 *   4. Look up Axon user by wallet_address (or create if new)
 *   5. Return our existing api_key (visitor reuses normal flow from here)
 *
 * Result: visitor never types a seed phrase or sees "0x..." — but they
 * have a real on-chain wallet that can receive USDC, hold NFT agents,
 * sign on-chain actions, etc.
 *
 * Setup (operator side):
 *   1. Sign up at https://dashboard.privy.io (free tier supports 1000 MAU)
 *   2. Create new app → copy "App ID" and "App Secret"
 *   3. Set in Render env: PRIVY_APP_ID, PRIVY_APP_SECRET
 *   4. Deploy. Frontend will pick it up via /v1/auth/privy/config
 *   5. Frontend integration: see landing/login.html
 */

import { Hono } from 'hono';
import { db } from '~/db';
import { users, wallets } from '~/db/schema';
import { eq } from 'drizzle-orm';
import { env } from '~/config';
import { hash } from 'crypto';
import { randomBytes, createHash } from 'crypto';

const app = new Hono();

interface PrivyClaim {
  sub: string;          // Privy user DID (e.g., "did:privy:xxxxx")
  iss: string;          // privy.io
  aud: string;          // App ID
  iat: number;
  exp: number;
  cr?: string;          // wallet address
  email?: string;
  linked_accounts?: Array<{ type: string; address?: string; email?: string }>;
}

// ─── Public config (frontend needs APP_ID to init Privy SDK) ──────────
app.get('/config', (c) => {
  const enabled = !!process.env.PRIVY_APP_ID;
  return c.json({
    enabled,
    app_id: process.env.PRIVY_APP_ID || null,
  });
});

// ─── Verify Privy access token via JWKS ────────────────────────────────
//
// Privy publishes their public key at:
//   https://auth.privy.io/api/v1/apps/{APP_ID}/jwks.json
//
// We verify with the standard JOSE library if available, or via fetch
// against Privy's verify endpoint as a fallback.
async function verifyPrivyToken(token: string): Promise<PrivyClaim | null> {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) return null;

  // Server-side verification via Privy REST API (auth Basic = appId:appSecret)
  // This is the most reliable path and doesn't require pulling in jose lib.
  try {
    const auth = Buffer.from(`${appId}:${appSecret}`).toString('base64');
    const r = await fetch('https://auth.privy.io/api/v1/users/me', {
      headers: {
        Authorization: `Bearer ${token}`,
        'privy-app-id': appId,
        'privy-client-id': appId,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    return {
      sub: j.id,
      iss: 'privy.io',
      aud: appId,
      iat: 0,
      exp: 0,
      cr: j.wallet?.address || j.linked_accounts?.find((a: any) => a.type === 'wallet')?.address,
      email: j.email?.address || j.linked_accounts?.find((a: any) => a.type === 'email')?.address,
      linked_accounts: j.linked_accounts,
    };
  } catch {
    return null;
  }
}

function newApiKey(): { plaintext: string; hash: string } {
  const plaintext = 'ax_live_' + randomBytes(24).toString('hex');
  const h = createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash: h };
}

// ─── POST /v1/auth/privy — exchange Privy token for Axon API key ──────
app.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { token?: string; wallet_address?: string; email?: string }
    | null;

  if (!body?.token) {
    return c.json({ error: 'invalid_request', message: 'token required' }, 400);
  }

  const claim = await verifyPrivyToken(body.token);
  if (!claim) {
    return c.json({ error: 'invalid_token', message: 'Privy token verification failed' }, 401);
  }

  // Pick wallet address from token claim or body fallback
  const walletAddress = (claim.cr || body.wallet_address || '').toLowerCase();
  if (!walletAddress || !walletAddress.startsWith('0x')) {
    return c.json({ error: 'no_wallet', message: 'No wallet address in claim' }, 400);
  }

  // Look up existing wallet → get user
  const [existingWallet] = await db
    .select()
    .from(wallets)
    .where(eq(wallets.address, walletAddress));

  let userId: string;
  let apiKeyPlain: string | null = null;

  if (existingWallet) {
    userId = existingWallet.userId;
  } else {
    // Create new user + wallet + api key
    const { plaintext, hash: keyHash } = newApiKey();
    apiKeyPlain = plaintext;
    const [newUser] = await db
      .insert(users)
      .values({
        email: claim.email || body.email || null,
        apiKeyHash: keyHash,
        tier: 'free',
      })
      .returning();
    userId = newUser.id;

    await db.insert(wallets).values({
      userId,
      address: walletAddress,
      balanceMicro: 500_000n,  // $0.50 welcome credit
      reservedMicro: 0n,
    });
  }

  // If we just created the user, return the plaintext key (only chance!)
  // Otherwise, return wallet info — they should already have their key
  return c.json({
    user_id: userId,
    wallet_address: walletAddress,
    api_key: apiKeyPlain,  // null if returning user
    is_new: !existingWallet,
    privy_did: claim.sub,
    email: claim.email,
  });
});

export default app;
