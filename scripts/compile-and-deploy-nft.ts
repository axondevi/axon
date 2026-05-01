/**
 * Compile + deploy AxonAgent.sol to Base Sepolia.
 *
 * Self-contained — uses solc-js for compilation and viem for deploy.
 * Reads MINTER_PRIVATE_KEY from env.
 *
 * Run:
 *   MINTER_PRIVATE_KEY=0x... bun run scripts/compile-and-deploy-nft.ts
 *
 * On success, prints CONTRACT_ADDRESS to stdout.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type Abi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
// @ts-ignore — solc has no types
import solc from 'solc';

const SOLC_VERSION = '0.8.24';
const RPC = process.env.NFT_RPC_URL || 'https://sepolia.base.org';
const PRIV = process.env.MINTER_PRIVATE_KEY as Hex | undefined;

if (!PRIV || !PRIV.startsWith('0x')) {
  console.error('ERROR: MINTER_PRIVATE_KEY env required (0x... hex)');
  process.exit(1);
}

const account = privateKeyToAccount(PRIV);
console.log('Deployer:', account.address);

// ─── 1. Compile ─────────────────────────────────────
const contractsDir = join(import.meta.dir, '..', 'contracts');
const source = readFileSync(join(contractsDir, 'AxonAgent.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'AxonAgent.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    evmVersion: 'paris',
  },
};

console.log('Compiling AxonAgent.sol with solc', solc.version());
const output = JSON.parse(solc.compile(JSON.stringify(input)));
if (output.errors) {
  const fatal = output.errors.filter((e: any) => e.severity === 'error');
  if (fatal.length) {
    console.error('Solidity errors:');
    fatal.forEach((e: any) => console.error(e.formattedMessage));
    process.exit(1);
  }
  // warnings — just print
  output.errors.forEach((e: any) => console.warn(e.formattedMessage));
}
const compiled = output.contracts['AxonAgent.sol']['AxonAgent'];
const abi: Abi = compiled.abi;
const bytecode = ('0x' + compiled.evm.bytecode.object) as Hex;
console.log('Compiled. bytecode size:', bytecode.length / 2 - 1, 'bytes');

// Save artifacts for later use (the runtime might want the ABI too)
const artifactPath = join(contractsDir, 'AxonAgent.compiled.json');
writeFileSync(artifactPath, JSON.stringify({ abi, bytecode }, null, 2));
console.log('Artifact saved:', artifactPath);

// ─── 2. Check balance + gas estimate ─────────────────
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const balance = await publicClient.getBalance({ address: account.address });
console.log('Balance:', Number(balance) / 1e18, 'ETH');
if (balance < 1_000_000_000_000_000n /* 0.001 ETH */) {
  console.warn('WARNING: balance below 0.001 ETH — deploy may fail');
}

// ─── 3. Deploy ───────────────────────────────────────
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(RPC),
});

console.log('Deploying AxonAgent...');
const txHash = await walletClient.deployContract({
  abi,
  bytecode,
  // Constructor: (address _minter, address _royaltyReceiver)
  // Both are the minter wallet itself for now — when royalties are paid (sales
  // on OpenSea), they go to the same address controlling mints. Easy to rotate
  // later via setRoyalty(...) which is onlyOwner.
  args: [account.address, account.address],
});
console.log('Deploy tx submitted:', txHash);
console.log('Waiting for confirmation (~10s on Base)...');

const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== 'success' || !receipt.contractAddress) {
  console.error('Deploy FAILED. Receipt:', receipt);
  process.exit(1);
}

console.log('✅ DEPLOYED');
console.log('Contract address:', receipt.contractAddress);
console.log('Block:', receipt.blockNumber);
console.log('Gas used:', receipt.gasUsed.toString());
console.log('Explorer:', `https://sepolia.basescan.org/address/${receipt.contractAddress}`);

// ─── 4. Sanity check: read totalSupply ───────────────
const totalSupply = await publicClient.readContract({
  address: receipt.contractAddress,
  abi,
  functionName: 'totalSupply',
});
console.log('totalSupply:', totalSupply); // should be 0n
const minter = await publicClient.readContract({
  address: receipt.contractAddress,
  abi,
  functionName: 'minter',
});
console.log('minter:', minter); // should equal account.address

// ─── 5. Print copy-paste env block ──────────────────
console.log('\n──── ENV VARS FOR RENDER ────');
console.log(`NFT_CONTRACT_ADDRESS=${receipt.contractAddress}`);
console.log(`NFT_RPC_URL=${RPC}`);
console.log(`NFT_METADATA_BASE_URL=https://axon-5zf.pages.dev/agent-meta`);
console.log(`NFT_MINTER_PRIVATE_KEY=<keep secret — set separately>`);
