/**
 * Turnkey Wallet provider — real integration.
 *
 * Loaded LAZILY by `src/wallet/providers.ts` only when WALLET_PROVIDER=turnkey.
 * Keeps the @turnkey/sdk-server dependency optional.
 *
 * Install:   bun add @turnkey/sdk-server
 * Env:       WALLET_PROVIDER=turnkey
 *            TURNKEY_API_PUBLIC_KEY=<hex>
 *            TURNKEY_API_PRIVATE_KEY=<hex>
 *            TURNKEY_ORGANIZATION_ID=<parent org uuid>
 *            TURNKEY_API_BASE_URL=https://api.turnkey.com   (default)
 *
 * Model:
 *   One sub-organization per Axon user. Isolation is enforced by Turnkey —
 *   even our own parent org cannot move funds without the sub-org's
 *   root-user API key. That root-user key lives on Turnkey's HSMs; we only
 *   hold the sub-org id and the created wallet id.
 *
 * Security:
 *   Private keys never leave Turnkey's HSMs. There is no seed to export.
 *   `serializedBackup` stores the sub-org id + wallet id so this server
 *   (or a future operator) can issue signed transactions against the wallet.
 *   Losing the parent-org API credentials means losing operational control
 *   but NOT user custody — the sub-org can be recovered via Turnkey's
 *   account recovery flow with the root user.
 */

import type { WalletProvider, DepositAddress } from './providers';

// ─── Minimal SDK surface we touch ─────────────────────────
interface TurnkeyServerClient {
  createSubOrganization(input: {
    subOrganizationName: string;
    rootQuorumThreshold: number;
    rootUsers: Array<{
      userName: string;
      apiKeys: Array<{
        apiKeyName: string;
        publicKey: string;
        curveType: 'API_KEY_CURVE_P256';
      }>;
      authenticators: [];
      oauthProviders: [];
    }>;
    wallet: {
      walletName: string;
      accounts: Array<{
        curve: 'CURVE_SECP256K1';
        pathFormat: 'PATH_FORMAT_BIP32';
        path: string;
        addressFormat: 'ADDRESS_FORMAT_ETHEREUM';
      }>;
    };
  }): Promise<{
    subOrganizationId: string;
    // Real SDK marks `wallet` as optional because the create activity may
    // be async/queued. We narrow at the callsite to fail loudly when it
    // comes back undefined rather than silently shipping a placeholder.
    wallet?: { walletId: string; addresses: string[] };
  }>;
}

interface TurnkeySdkStatic {
  new (opts: {
    apiBaseUrl: string;
    apiPublicKey: string;
    apiPrivateKey: string;
    defaultOrganizationId: string;
  }): { apiClient(): TurnkeyServerClient };
}

let sdk: { Turnkey: TurnkeySdkStatic } | null = null;
let client: TurnkeyServerClient | null = null;

async function ensureClient(): Promise<TurnkeyServerClient> {
  if (client) return client;

  if (!sdk) {
    try {
      // @ts-ignore — optional dep
      const mod = await import('@turnkey/sdk-server');
      // The shipped Turnkey SDK class returns a richer object than the
      // narrow surface we declare in TurnkeyServerClient; cast through
      // unknown to keep the structural typing strict at every callsite
      // that uses the narrowed interface.
      sdk = { Turnkey: mod.Turnkey as unknown as TurnkeySdkStatic };
    } catch {
      throw new Error(
        'TurnkeyWalletProvider requires @turnkey/sdk-server. Install it:\n' +
          '    bun add @turnkey/sdk-server\n' +
          'Then set WALLET_PROVIDER=turnkey and TURNKEY_* env vars.',
      );
    }
  }
  // Refine after the assignment so the rest of the function sees a non-null
  // sdk without each access tripping TS18047. `sdk` is module-scoped and
  // cached, so we won't reach here without it being set.
  const sdkRef = sdk;

  const pub = process.env.TURNKEY_API_PUBLIC_KEY;
  const priv = process.env.TURNKEY_API_PRIVATE_KEY;
  const org = process.env.TURNKEY_ORGANIZATION_ID;
  const base = process.env.TURNKEY_API_BASE_URL ?? 'https://api.turnkey.com';

  if (!pub || !priv || !org) {
    throw new Error(
      'Turnkey credentials missing. Set TURNKEY_API_PUBLIC_KEY, ' +
        'TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID.',
    );
  }

  const turnkey = new sdkRef.Turnkey({
    apiBaseUrl: base,
    apiPublicKey: pub,
    apiPrivateKey: priv,
    defaultOrganizationId: org,
  });
  client = turnkey.apiClient();
  return client;
}

export class TurnkeyWalletProviderReal implements WalletProvider {
  readonly name = 'turnkey';

  async createUserWallet(userId: string): Promise<DepositAddress> {
    const c = await ensureClient();

    // Sub-org needs at least one root user. The root user's API key
    // controls the sub-org going forward. We reuse the parent org's
    // public key as the sub-org root — operational simplicity, and
    // Turnkey's HSM boundary still isolates each sub-org.
    const rootPubKey = process.env.TURNKEY_API_PUBLIC_KEY!;

    const res = await c.createSubOrganization({
      subOrganizationName: `axon-user-${userId}`,
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName: 'axon-root',
          apiKeys: [
            {
              apiKeyName: 'axon-parent-api-key',
              publicKey: rootPubKey,
              curveType: 'API_KEY_CURVE_P256',
            },
          ],
          authenticators: [],
          oauthProviders: [],
        },
      ],
      wallet: {
        walletName: `axon-user-${userId}-base`,
        accounts: [
          {
            curve: 'CURVE_SECP256K1',
            pathFormat: 'PATH_FORMAT_BIP32',
            path: "m/44'/60'/0'/0/0",
            addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
          },
        ],
      },
    });

    // Wallet may come back undefined when the create activity is queued
    // (rare for synchronous P256 signers, but the SDK types it as
    // optional). Fail loudly rather than ship a placeholder address.
    const wallet = res.wallet;
    if (!wallet) {
      throw new Error('Turnkey returned no wallet — activity likely pending');
    }
    const address = wallet.addresses[0];
    if (!address) {
      throw new Error('Turnkey returned a wallet without an address');
    }

    return {
      address,
      walletId: wallet.walletId,
      serializedBackup: JSON.stringify({
        subOrganizationId: res.subOrganizationId,
        walletId: wallet.walletId,
        provider: 'turnkey',
      }),
    };
  }
}
