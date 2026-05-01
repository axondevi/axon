/**
 * NFT Agent Mint — silently mint each new agent as ERC-721 on Base.
 *
 * Why "silent": users see "I created my agent" — they never see "NFT".
 * The mint happens in background after agent.create. Failures don't block
 * agent creation (it's a soft enhancement). When successful, the agent
 * record is updated with `nft_token_id` for later transfers/marketplace.
 *
 * Cost: ~$0.005 per mint on Base. Axon pays via paymaster wallet
 * (NFT_MINTER_PRIVATE_KEY env). For 10k agents/year = $50/year — trivial.
 *
 * Setup (operator side):
 *   1. Deploy AxonAgent.sol on Base mainnet (use Foundry / Hardhat / Remix)
 *      - Constructor args: (minter_address, royalty_receiver_address)
 *      - Where minter_address = a wallet you control (paymaster)
 *   2. Fund minter wallet with ~0.01 ETH on Base for gas (~$30)
 *   3. Set in Render env:
 *        NFT_CONTRACT_ADDRESS=0x...
 *        NFT_MINTER_PRIVATE_KEY=0x...  (the minter wallet's private key)
 *        NFT_RPC_URL=https://mainnet.base.org
 *        NFT_METADATA_BASE_URL=https://axon-5zf.pages.dev/agent-meta
 *   4. Re-deploy. Mints will start happening on every new agent.
 *
 * Stays disabled if env vars missing — call sites become no-ops gracefully.
 */

import { log } from '~/lib/logger';

// Module-scoped serializer. The minter wallet has ONE on-chain nonce; if
// two mints fire concurrently we either reuse a nonce (revert) or skip
// one (stuck pending). A simple in-memory promise chain serializes
// every writeContract call from this signer. The chain is per-process,
// which matches Render's single-instance default — multi-instance
// deployments would need a Redis-backed lock instead.
let mintQueue: Promise<unknown> = Promise.resolve();

interface MintParams {
  to: string;          // recipient wallet (user's embedded wallet)
  agentId: string;     // UUID — used to derive tokenId deterministically
  slug: string;        // human-readable for events
  metadataUrl: string; // tokenURI (ipfs:// or https://)
}

export interface MintResult {
  ok: boolean;
  txHash?: string;
  tokenId?: string;
  reason?: string;
}

/**
 * Convert agent UUID to uint256 tokenId (deterministic, collision-free).
 * UUIDs have 122 random bits → fit in uint256 with room to spare.
 */
function uuidToTokenId(uuid: string): bigint {
  const hex = uuid.replace(/-/g, '');
  return BigInt('0x' + hex);
}

/**
 * Check if NFT minting is configured. If not, all mint() calls become no-ops.
 */
export function isNftEnabled(): boolean {
  return !!(
    process.env.NFT_CONTRACT_ADDRESS &&
    process.env.NFT_MINTER_PRIVATE_KEY &&
    process.env.NFT_RPC_URL
  );
}

/**
 * Mint a new agent NFT to the user's wallet. Silent failure on misconfig
 * (returns ok:false but doesn't throw — callers continue normally).
 */
export async function mintAgentNft(params: MintParams): Promise<MintResult> {
  if (!isNftEnabled()) {
    return { ok: false, reason: 'nft_disabled' };
  }

  const contractAddress = process.env.NFT_CONTRACT_ADDRESS!;
  const minterKey = process.env.NFT_MINTER_PRIVATE_KEY!;
  const rpcUrl = process.env.NFT_RPC_URL!;

  const tokenId = uuidToTokenId(params.agentId);

  try {
    // Use viem dynamically (avoid hard dep if user doesn't enable NFT)
    const viem = await import('viem').catch(() => null);
    const accounts = await import('viem/accounts').catch(() => null);
    const baseChain = await import('viem/chains').catch(() => null);

    if (!viem || !accounts || !baseChain) {
      log.warn('nft_viem_missing', { msg: 'viem package not installed; install with `bun add viem`' });
      return { ok: false, reason: 'viem_missing' };
    }

    // Auto-detect Base mainnet vs Base Sepolia from the RPC URL.
    // The wrong chainId on a tx makes the RPC reject with cryptic
    // "Missing or invalid parameters" — easy to miss without this branch.
    const isSepolia = /sepolia/i.test(rpcUrl);
    const chain = isSepolia ? baseChain.baseSepolia : baseChain.base;

    const minterAccount = accounts.privateKeyToAccount(minterKey as `0x${string}`);
    const walletClient = viem.createWalletClient({
      account: minterAccount,
      chain,
      transport: viem.http(rpcUrl),
    });

    // mint(address to, uint256 tokenId, string uri, string slug)
    const mintAbi = [
      {
        type: 'function',
        name: 'mint',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'tokenId', type: 'uint256' },
          { name: 'uri', type: 'string' },
          { name: 'slug', type: 'string' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
      // ownerOf reverts when tokenId isn't minted; we use that to detect
      // an already-minted token before sending a duplicate write.
      {
        type: 'function',
        name: 'ownerOf',
        inputs: [{ name: 'tokenId', type: 'uint256' }],
        outputs: [{ name: '', type: 'address' }],
        stateMutability: 'view',
      },
    ] as const;

    // Pre-flight: if this tokenId is already minted, return idempotent
    // success rather than burning gas on a sure-revert. Cheap eth_call.
    const publicClient = viem.createPublicClient({
      chain,
      transport: viem.http(rpcUrl),
    });
    try {
      const owner = await publicClient.readContract({
        address: contractAddress as `0x${string}`,
        abi: mintAbi,
        functionName: 'ownerOf',
        args: [tokenId],
      });
      // ownerOf returned without revert → token already minted, idempotent return.
      log.info('nft_already_minted', {
        agentId: params.agentId,
        tokenId: tokenId.toString(),
        owner,
      });
      return { ok: true, tokenId: tokenId.toString(), reason: 'already_minted' };
    } catch {
      // ownerOf reverted → token not yet minted, proceed.
    }

    // Serialize through the per-process queue so concurrent mints from
    // the same signer don't fight for the same nonce. The chain captures
    // any error so a single failed mint doesn't poison the queue forever.
    const txHash = await (mintQueue = mintQueue.then(
      () => walletClient.writeContract({
        address: contractAddress as `0x${string}`,
        abi: mintAbi,
        functionName: 'mint',
        args: [params.to as `0x${string}`, tokenId, params.metadataUrl, params.slug],
      }),
      () => walletClient.writeContract({
        address: contractAddress as `0x${string}`,
        abi: mintAbi,
        functionName: 'mint',
        args: [params.to as `0x${string}`, tokenId, params.metadataUrl, params.slug],
      }),
    )) as `0x${string}`;

    log.info('nft_minted', {
      agentId: params.agentId,
      tokenId: tokenId.toString(),
      to: params.to,
      txHash,
    });

    return { ok: true, txHash, tokenId: tokenId.toString() };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('nft_mint_failed', {
      agentId: params.agentId,
      to: params.to,
      error: msg,
    });
    return { ok: false, reason: msg };
  }
}

/**
 * Build the metadata URL for an agent. The endpoint /agent-meta/:slug
 * (served by frontend) returns a JSON conforming to OpenSea metadata standard.
 */
export function buildMetadataUrl(slug: string): string {
  const base = process.env.NFT_METADATA_BASE_URL || 'https://axon-5zf.pages.dev/agent-meta';
  return `${base}/${slug}.json`;
}
