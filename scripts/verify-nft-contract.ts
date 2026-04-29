/**
 * Verify AxonAgent.sol on Basescan Sepolia.
 *
 * Single-file submission via Etherscan-compatible API. Optional API key
 * (rate-limited if absent — fine for one-shot).
 *
 * Run:
 *   BASESCAN_API_KEY=<optional> bun run scripts/verify-nft-contract.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeAbiParameters } from 'viem';

const CONTRACT_ADDRESS = '0x41d8e782a1a2e010cb06861d8d23c6ccc1d5949e';
const CONTRACT_NAME = 'AxonAgent';
const COMPILER_VERSION = 'v0.8.34+commit.80d5c536'; // matches solcjs 0.8.34 used at deploy
const MINTER = '0x5FF34B80ce5d3Ac8A30E8810dF0E9d9F6507EcfD';
const ROYALTY_RECEIVER = '0x5FF34B80ce5d3Ac8A30E8810dF0E9d9F6507EcfD';

// Etherscan V2 (single multichain endpoint). chainid=84532 → Base Sepolia.
const API_BASE = 'https://api.etherscan.io/v2/api';
const CHAIN_ID = '84532';
const apiKey = process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY || '';
if (!apiKey) {
  console.warn('⚠ No ETHERSCAN_API_KEY env — V2 requires one. Get free at https://etherscan.io/apis');
  console.warn('  (Single key works across all chains incl. Base Sepolia.)');
  process.exit(1);
}

const sourcePath = join(import.meta.dir, '..', 'contracts', 'AxonAgent.sol');
const sourceCode = readFileSync(sourcePath, 'utf8');

// ABI-encode constructor args (without 0x prefix).
const constructorArgs = encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }],
  [MINTER as `0x${string}`, ROYALTY_RECEIVER as `0x${string}`],
).slice(2);

console.log('Submitting verification to Basescan Sepolia…');
console.log('  Contract:', CONTRACT_ADDRESS);
console.log('  Compiler:', COMPILER_VERSION);
console.log('  Source:', sourceCode.length, 'bytes');
console.log('  Args:', constructorArgs);

const params = new URLSearchParams({
  chainid: CHAIN_ID,
  module: 'contract',
  action: 'verifysourcecode',
  apikey: apiKey,
  contractaddress: CONTRACT_ADDRESS,
  sourceCode,
  codeformat: 'solidity-single-file',
  contractname: CONTRACT_NAME,
  compilerversion: COMPILER_VERSION,
  optimizationUsed: '1',
  runs: '200',
  constructorArguements: constructorArgs, // (sic) Etherscan API uses this typo
  evmversion: 'paris',
  licenseType: '3', // 3 = MIT
});

const submit = await fetch(API_BASE, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: params.toString(),
});
const submitData = await submit.json();
console.log('Submit response:', submitData);

if (submitData.status !== '1') {
  console.error('Submission FAILED:', submitData.result || submitData.message);
  process.exit(1);
}

const guid = submitData.result;
console.log('Submission accepted. GUID:', guid);
console.log('Polling for verification result (up to 60s)…');

// Poll status: action=checkverifystatus&guid=<guid>
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const checkParams = new URLSearchParams({
    chainid: CHAIN_ID,
    module: 'contract',
    action: 'checkverifystatus',
    guid,
    apikey: apiKey,
  });
  const check = await fetch(`${API_BASE}?${checkParams}`);
  const checkData = await check.json();
  process.stdout.write(`  [${i + 1}/20] ${checkData.result}\n`);
  if (String(checkData.result).toLowerCase().includes('pass')) {
    console.log('\n✅ VERIFIED');
    console.log(`https://sepolia.basescan.org/address/${CONTRACT_ADDRESS}#code`);
    process.exit(0);
  }
  if (String(checkData.result).toLowerCase().includes('fail')) {
    console.error('\n❌ VERIFICATION FAILED:', checkData.result);
    process.exit(1);
  }
}
console.warn('Timed out after 60s. Check manually:');
console.warn(`https://sepolia.basescan.org/address/${CONTRACT_ADDRESS}#code`);
