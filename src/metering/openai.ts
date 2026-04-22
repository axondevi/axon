import type { MeteringCalculator } from './types';

/**
 * Pricing table in micro-USDC per 1M tokens.
 * Values are deliberately conservative; update from the OpenAI pricing page.
 */
const PRICING: Record<string, { in: bigint; out: bigint }> = {
  'gpt-4o': { in: 2_500_000n, out: 10_000_000n },
  'gpt-4o-mini': { in: 150_000n, out: 600_000n },
  'gpt-4.1': { in: 2_000_000n, out: 8_000_000n },
  'gpt-4.1-mini': { in: 400_000n, out: 1_600_000n },
  'o1': { in: 15_000_000n, out: 60_000_000n },
  'o3-mini': { in: 1_100_000n, out: 4_400_000n },
  // Fallback if model string not recognized
  default: { in: 2_500_000n, out: 10_000_000n },
};

export const openaiChat: MeteringCalculator = ({ responseBody }) => {
  const body = responseBody as {
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;

  if (!body?.usage) return {};

  const modelKey = matchModel(body.model ?? '');
  const price = PRICING[modelKey] ?? PRICING.default;

  const inTokens = BigInt(body.usage.prompt_tokens ?? 0);
  const outTokens = BigInt(body.usage.completion_tokens ?? 0);

  const costMicro =
    (price.in * inTokens) / 1_000_000n + (price.out * outTokens) / 1_000_000n;

  return {
    actualCostMicro: costMicro,
    notes: {
      model: body.model,
      prompt_tokens: body.usage.prompt_tokens,
      completion_tokens: body.usage.completion_tokens,
      resolved_model_key: modelKey,
    },
  };
};

function matchModel(m: string): string {
  const lower = m.toLowerCase();
  if (lower.startsWith('gpt-4o-mini')) return 'gpt-4o-mini';
  if (lower.startsWith('gpt-4o')) return 'gpt-4o';
  if (lower.startsWith('gpt-4.1-mini')) return 'gpt-4.1-mini';
  if (lower.startsWith('gpt-4.1')) return 'gpt-4.1';
  if (lower.startsWith('o1')) return 'o1';
  if (lower.startsWith('o3-mini')) return 'o3-mini';
  return 'default';
}
