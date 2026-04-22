/**
 * @axon/vercel-ai — Vercel AI SDK tools backed by Axon.
 *
 *   import { Axon } from '@axon/client';
 *   import { axonTool, axonToolset } from '@axon/vercel-ai';
 *   import { generateText } from 'ai';
 *   import { openai } from '@ai-sdk/openai';
 *
 *   const axon = new Axon({ apiKey: process.env.AXON_KEY! });
 *
 *   const { text } = await generateText({
 *     model: openai('gpt-4o-mini'),
 *     tools: {
 *       search: axonTool(axon, 'serpapi', 'search', {
 *         description: 'Search the web',
 *         parameters: z.object({ q: z.string() }),
 *         via: 'params',
 *       }),
 *     },
 *     prompt: 'What is the top news today?',
 *   });
 */

import { tool, type Tool } from 'ai';
import type { z } from 'zod';
import type { Axon } from '@axon/client';

export interface AxonToolConfig<S extends z.ZodTypeAny> {
  description: string;
  parameters: S;
  /** How to pass params to the upstream: query string vs. body */
  via?: 'params' | 'body';
  /** Custom response shaper for the tool's text output */
  shape?: (data: unknown, meta: { cost: string; cacheHit: boolean }) => unknown;
}

/**
 * Wrap an Axon endpoint as a single Vercel AI SDK tool.
 */
export function axonTool<S extends z.ZodTypeAny>(
  axon: Axon,
  slug: string,
  endpoint: string,
  cfg: AxonToolConfig<S>,
): Tool {
  return tool({
    description: cfg.description,
    parameters: cfg.parameters,
    execute: async (input: z.infer<S>) => {
      const via = cfg.via ?? 'body';
      const result =
        via === 'params'
          ? await axon.call(slug, endpoint, input as any)
          : await axon.call(slug, endpoint, undefined, input);

      if (cfg.shape) {
        return cfg.shape(result.data, {
          cost: result.costUsdc,
          cacheHit: result.cacheHit,
        });
      }
      return {
        data: result.data,
        _meta: {
          cost_usdc: result.costUsdc,
          cache_hit: result.cacheHit,
          latency_ms: result.latencyMs,
        },
      };
    },
  });
}

/**
 * Fetch the Axon catalog and return a tools dict ready to spread into
 * generateText / streamText `tools:`.
 *
 * Keys are `{slug}__{endpoint}`. Schemas are loose (`z.record(z.any())`) —
 * override per-tool for tighter inputs.
 */
export async function axonToolset(axon: Axon, zod: typeof import('zod')) {
  const apis = await axon.apis.list();
  const out: Record<string, Tool> = {};

  for (const api of apis) {
    for (const endpoint of api.endpoints) {
      const key = `${api.slug}__${endpoint}`;
      out[key] = axonTool(axon, api.slug, endpoint, {
        description: `${api.provider} — ${api.category}: ${api.description}`,
        parameters: zod.record(zod.any()).describe(
          `Arguments for ${api.slug}/${endpoint}. See ${api.homepage ?? api.slug} for the schema.`,
        ),
      });
    }
  }

  return out;
}

export type { Axon } from '@axon/client';
