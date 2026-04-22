import type { MeteringCalculator } from './types';

/** Together.ai exposes model-dependent pricing. Keep a conservative default
 *  and extend as needed. Micro-USDC per 1M tokens. */
const DEFAULT = { in: 500_000n, out: 500_000n };

export const togetherChat: MeteringCalculator = ({ responseBody }) => {
  const body = responseBody as {
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;

  if (!body?.usage) return {};

  const inTokens = BigInt(body.usage.prompt_tokens ?? 0);
  const outTokens = BigInt(body.usage.completion_tokens ?? 0);

  const costMicro =
    (DEFAULT.in * inTokens) / 1_000_000n + (DEFAULT.out * outTokens) / 1_000_000n;

  return {
    actualCostMicro: costMicro,
    notes: {
      model: body.model,
      prompt_tokens: body.usage.prompt_tokens,
      completion_tokens: body.usage.completion_tokens,
    },
  };
};
