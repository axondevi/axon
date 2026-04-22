import type { MeteringCalculator } from './types';

/** Micro-USDC per 1M tokens. */
const PRICING: Record<string, { in: bigint; out: bigint }> = {
  'claude-opus-4-7': { in: 15_000_000n, out: 75_000_000n },
  'claude-sonnet-4-6': { in: 3_000_000n, out: 15_000_000n },
  'claude-haiku-4-5': { in: 800_000n, out: 4_000_000n },
  default: { in: 3_000_000n, out: 15_000_000n },
};

export const anthropicMessages: MeteringCalculator = ({ responseBody }) => {
  const body = responseBody as {
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  } | null;

  if (!body?.usage) return {};

  const modelKey = matchModel(body.model ?? '');
  const price = PRICING[modelKey] ?? PRICING.default;

  const inTokens = BigInt(body.usage.input_tokens ?? 0);
  const outTokens = BigInt(body.usage.output_tokens ?? 0);

  const costMicro =
    (price.in * inTokens) / 1_000_000n + (price.out * outTokens) / 1_000_000n;

  return {
    actualCostMicro: costMicro,
    notes: {
      model: body.model,
      input_tokens: body.usage.input_tokens,
      output_tokens: body.usage.output_tokens,
      resolved_model_key: modelKey,
    },
  };
};

function matchModel(m: string): string {
  const lower = m.toLowerCase();
  if (lower.includes('opus-4')) return 'claude-opus-4-7';
  if (lower.includes('sonnet-4')) return 'claude-sonnet-4-6';
  if (lower.includes('haiku-4')) return 'claude-haiku-4-5';
  return 'default';
}
