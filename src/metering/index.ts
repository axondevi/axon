import type { MeteringCalculator, MeteringContext, MeteringResult } from './types';
import { openaiChat } from './openai';
import { anthropicMessages } from './anthropic';
import { togetherChat } from './together';

/**
 * Registry of per-(slug, endpoint) metering calculators.
 * Key format: "{slug}:{endpoint}".
 */
const CALCULATORS: Record<string, MeteringCalculator> = {
  'openai:chat': openaiChat,
  'anthropic:messages': anthropicMessages,
  'together:chat': togetherChat,
  'together:completions': togetherChat,
};

/** Lookup a calculator, or return null if the endpoint is flat-priced. */
export function calculatorFor(
  slug: string,
  endpoint: string,
): MeteringCalculator | null {
  return CALCULATORS[`${slug}:${endpoint}`] ?? null;
}

export type { MeteringCalculator, MeteringContext, MeteringResult };
