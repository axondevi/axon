/**
 * Verify AxonAgent.sol via Sourcify — permissionless, no API key needed.
 *
 * Sourcify (sourcify.dev) is the W3C reference verifier. Successful matches
 * are picked up by Basescan and show as "Verified by Sourcify" alongside
 * the source code on the contract page.
 *
 * Submission requires (a) the Solidity source files and (b) the metadata
 * JSON solc emits (it contains compiler settings + a bytecode hash that
 * Sourcify uses to match against on-chain code).
 *
 * We re-compile here with `metadata` enabled (the deploy artifact didn't
 * save it) so we get a clean canonical metadata blob.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-ignore — solc has no types
import solc from 'solc';

const CONTRACT_ADDRESS = '0x41d8e782a1a2e010cb06861d8d23c6ccc1d5949e';
const CHAIN_ID = 84532; // Base Sepolia

const sourcePath = join(import.meta.dir, '..', 'contracts', 'AxonAgent.sol');
const sourceCode = readFileSync(sourcePath, 'utf8');

console.log('Re-compiling AxonAgent with metadata output…');
const input = {
  language: 'Solidity',
  sources: { 'AxonAgent.sol': { content: sourceCode } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'metadata'] },
    },
    evmVersion: 'paris',
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
if (output.errors) {
  const fatal = output.errors.filter((e: any) => e.severity === 'error');
  if (fatal.length) {
    console.error('Solidity errors:');
    fatal.forEach((e: any) => console.error(e.formattedMessage));
    process.exit(1);
  }
}
const compiled = output.contracts['AxonAgent.sol']['AxonAgent'];
const metadata: string = compiled.metadata;
if (!metadata) {
  console.error('No metadata emitted — check solc settings');
  process.exit(1);
}
console.log('Metadata length:', metadata.length);

// Sourcify wants the metadata as a JSON file named exactly "metadata.json"
// and the source file named as it appears in the metadata sources field.
// Simpler: send via the JSON-import route (newer Sourcify API).

// /server/verify expects a multipart form with files. We use the modern
// JSON-input endpoint /server/files/any which accepts a parsed JSON.
const SOURCIFY = 'https://sourcify.dev/server';

const files: Record<string, string> = {
  'metadata.json': metadata,
  'AxonAgent.sol': sourceCode,
};

console.log(`Submitting to Sourcify (chain ${CHAIN_ID}, ${CONTRACT_ADDRESS})…`);
const res = await fetch(`${SOURCIFY}/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    address: CONTRACT_ADDRESS,
    chain: String(CHAIN_ID),
    files,
  }),
});
const data: any = await res.json().catch(() => ({}));
console.log('Sourcify response:', data);

if (Array.isArray(data.result)) {
  const r = data.result[0];
  if (r?.status === 'perfect' || r?.status === 'partial') {
    console.log(`\n✅ VERIFIED (${r.status} match)`);
    console.log(`Sourcify: https://repo.sourcify.dev/contracts/full_match/${CHAIN_ID}/${CONTRACT_ADDRESS}/`);
    console.log(`Basescan: https://sepolia.basescan.org/address/${CONTRACT_ADDRESS}#code`);
    process.exit(0);
  }
  console.error('Verification failed:', r);
  process.exit(1);
}

if (data.error) {
  console.error('Submission failed:', data.error);
  process.exit(1);
}

console.log('Unexpected response shape — manual check:');
console.log(`https://sepolia.basescan.org/address/${CONTRACT_ADDRESS}#code`);
