/**
 * @axon/mastra — Mastra tools backed by Axon.
 *
 *   import { Axon } from '@axon/client';
 *   import { axonMastraTool } from '@axon/mastra';
 *   import { Agent } from '@mastra/core';
 *
 *   const axon = new Axon({ apiKey: process.env.AXON_KEY! });
 *
 *   const tool = axonMastraTool(axon, 'serpapi', 'search', {
 *     id: 'web_search',
 *     description: 'Search the web via SerpAPI',
 *     inputSchema: z.object({ q: z.string() }),
 *     via: 'params',
 *   });
 */
import { createTool } from '@mastra/core';
import type { z } from 'zod';
import type { Axon } from '@axon/client';

export interface AxonMastraToolOpts<S extends z.ZodTypeAny> {
  id: string;
  description: string;
  inputSchema: S;
  via?: 'params' | 'body';
}

export function axonMastraTool<S extends z.ZodTypeAny>(
  axon: Axon,
  slug: string,
  endpoint: string,
  opts: AxonMastraToolOpts<S>,
) {
  return createTool({
    id: opts.id,
    description: opts.description,
    inputSchema: opts.inputSchema,
    execute: async ({ context }: { context: z.infer<S> }) => {
      const via = opts.via ?? 'body';
      const result =
        via === 'params'
          ? await axon.call(slug, endpoint, context as any)
          : await axon.call(slug, endpoint, undefined, context);

      return {
        data: result.data,
        _axon: {
          cost_usdc: result.costUsdc,
          cache_hit: result.cacheHit,
          latency_ms: result.latencyMs,
        },
      };
    },
  });
}

export type { Axon } from '@axon/client';
