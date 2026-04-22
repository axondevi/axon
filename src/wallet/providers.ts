/**
 * Pluggable wallet provider.
 *
 * Three implementations:
 *   - PlaceholderWalletProvider: derives deterministic address from user UUID.
 *     Use this for local dev and initial launch while you're on testnet.
 *   - CDPWalletProvider: creates a real per-user sub-wallet via Coinbase CDP.
 *   - TurnkeyWalletProvider: creates a per-user sub-org wallet on Turnkey
 *     (HSM-backed, no exported seed). Good for regions where Coinbase
 *     signup is blocked.
 *
 * Selector: env.WALLET_PROVIDER ∈ { 'placeholder' | 'cdp' | 'turnkey' }
 */

import { env } from '~/config';

export interface DepositAddress {
  address: string;
  /** Provider-specific wallet id. For CDP this is the CDP wallet UUID. */
  walletId?: string;
  /**
   * Opaque serialized seed/backup. For CDP this is the encrypted seed blob.
   * Store encrypted at rest (we already AES-GCM with MASTER_ENCRYPTION_KEY).
   * Never leaves the server.
   */
  serializedBackup?: string;
}

export interface WalletProvider {
  readonly name: string;
  createUserWallet(userId: string): Promise<DepositAddress>;
}

// ─── Placeholder (UUID-derived, no actual on-chain wallet) ─
class PlaceholderWalletProvider implements WalletProvider {
  readonly name = 'placeholder';

  async createUserWallet(userId: string): Promise<DepositAddress> {
    const address = `0x${userId.replace(/-/g, '').padEnd(40, '0').slice(0, 40)}`;
    return { address };
  }
}

// ─── Coinbase CDP (production) ────────────────────────────
// Real implementation lives in providers-cdp.ts (lazy-loaded so the
// @coinbase/coinbase-sdk dependency stays optional).
class CDPWalletProviderLazy implements WalletProvider {
  readonly name = 'cdp';
  private real: WalletProvider | null = null;

  async createUserWallet(userId: string): Promise<DepositAddress> {
    if (!this.real) {
      const { CDPWalletProviderReal } = await import('./providers-cdp');
      this.real = new CDPWalletProviderReal();
    }
    return this.real.createUserWallet(userId);
  }
}

// ─── Turnkey (production alternative) ─────────────────────
// Real implementation lives in providers-turnkey.ts (lazy-loaded so the
// @turnkey/sdk-server dependency stays optional).
class TurnkeyWalletProviderLazy implements WalletProvider {
  readonly name = 'turnkey';
  private real: WalletProvider | null = null;

  async createUserWallet(userId: string): Promise<DepositAddress> {
    if (!this.real) {
      const { TurnkeyWalletProviderReal } = await import('./providers-turnkey');
      this.real = new TurnkeyWalletProviderReal();
    }
    return this.real.createUserWallet(userId);
  }
}

// ─── Factory ──────────────────────────────────────────────
let _provider: WalletProvider | null = null;

export function getWalletProvider(): WalletProvider {
  if (_provider) return _provider;

  const kind = process.env.WALLET_PROVIDER ?? 'placeholder';
  switch (kind) {
    case 'cdp':
      _provider = new CDPWalletProviderLazy();
      break;
    case 'turnkey':
      _provider = new TurnkeyWalletProviderLazy();
      break;
    case 'placeholder':
    default:
      _provider = new PlaceholderWalletProvider();
      break;
  }
  return _provider;
}

// Re-export for testing
export { PlaceholderWalletProvider };
// Reference env so stale-imports don't break the bundler config check:
void env;
