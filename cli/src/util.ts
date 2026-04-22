import { createInterface } from 'node:readline/promises';

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

export function print(s: string) {
  process.stdout.write(s + '\n');
}

export function printError(s: string) {
  process.stderr.write(`\x1b[31merror\x1b[0m ${s}\n`);
}

export function fmtJSON(v: unknown): string {
  return JSON.stringify(
    v,
    (_k, val) => (typeof val === 'bigint' ? val.toString() : val),
    2,
  );
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true; // non-interactive → auto-yes (scripts)
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} (y/N) `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
