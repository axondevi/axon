/**
 * Coinbase CDP Wallet provider — real integration.
 *
 * This file is loaded LAZILY by `src/wallet/providers.ts` only when
 * WALLET_PROVIDER=cdp. That way the @coinbase/coinbase-sdk dependency is
 * truly optional — users on the placeholder provider don't need it.
 *
 * Install:   bun add @coinbase/coinbase-sdk
 * Env:       WALLET_PROVIDER=cdp
 *            CDP_API_KEY_NAME=organizations/.../apiKeys/...
 *            CDP_API_KEY_PRIVATE=<the multi-line private key, \n escaped>
 *            CDP_NETWORK_ID=base-mainnet   (or base-sepolia for testnet)
 *
 * Security:
 *   Each user wallet's exported seed is returned alongside the address and
 *   is encrypted + persisted by the caller (routes/wallet.ts) via the
 *   MASTER_ENCRYPTION_KEY → transactions.meta.backup_enc field.
 *   In production you should ALSO back up the seeds out-of-band (KMS,
 *   segregated storage, etc.). Losing them means losing custody of funds.
 */

import type { WalletProvider, DepositAddress } from './providers';

// ─── Types — mirror the @coinbase/coinbase-sdk surface minimally ─
interface CoinbaseStatic {
  configure(opts: { apiKeyName: string; privateKey: string }): void;
}
interface SdkAddress {
  getId(): string;
}
interface SdkWallet {
  getId(): string;
  getDefaultAddress(): Promise<SdkAddress>;
  export(): unknown; // encrypted seed blob — opaque
}
interface SdkWalletStatic {
  create(opts: { networkId: string }): Promise<SdkWallet>;
}

let sdk: { Coinbase: CoinbaseStatic; Wallet: SdkWalletStatic } | null = null;
let configured = false;

async function ensureSdk() {
  if (!sdk) {
    try {
      // Dynamic import — bundler won't fail if the package isn't installed.
      // @ts-ignore — optional dep
      const mod = await import('@coinbase/coinbase-sdk');
      sdk = { Coinbase: mod.Coinbase, Wallet: mod.Wallet };
    } catch (err) {
      // Preserve the underlying loader error as `cause` so debug logs can
      // tell apart "package missing" vs "package present but failed to
      // initialize" when triaging.
      throw new Error(
        'CDPWalletProvider requires @coinbase/coinbase-sdk. Install it:\n' +
          '    bun add @coinbase/coinbase-sdk\n' +
          'Then set WALLET_PROVIDER=cdp and CDP_API_KEY_NAME / CDP_API_KEY_PRIVATE.',
        { cause: err },
      );
    }
  }
  if (!configured) {
    const name = process.env.CDP_API_KEY_NAME;
    const priv = process.env.CDP_API_KEY_PRIVATE;
    if (!name || !priv) {
      throw new Error(
        'CDP credentials missing. Set CDP_API_KEY_NAME and CDP_API_KEY_PRIVATE.',
      );
    }
    sdk.Coinbase.configure({
      apiKeyName: name,
      // SDK expects a PEM with literal newlines. Env vars usually escape them.
      privateKey: priv.replace(/\\n/g, '\n'),
    });
    configured = true;
  }
  return sdk;
}

export class CDPWalletProviderReal implements WalletProvider {
  readonly name = 'cdp';

  async createUserWallet(_userId: string): Promise<DepositAddress> {
    const s = await ensureSdk();
    const networkId = process.env.CDP_NETWORK_ID ?? 'base-mainnet';

    const wallet = await s.Wallet.create({ networkId });
    const addr = await wallet.getDefaultAddress();
    const exported = wallet.export();

    // Encrypt the seed/exported backup INSIDE the provider so the cleartext
    // never crosses a module boundary. Previously the JSON-stringified seed
    // was returned in plaintext and only later cipher-wrapped at the route
    // layer — any logger middleware or accidental SQL log between provider
    // and route would have leaked it. By encrypting here we shrink the
    // exposure window to a single function. The route still treats the
    // payload as opaque.
    const { encrypt } = await import('~/lib/crypto');
    const ciphertext = encrypt(JSON.stringify(exported));

    return {
      address: addr.getId(),
      walletId: wallet.getId(),
      serializedBackup: ciphertext,
    };
  }
}
