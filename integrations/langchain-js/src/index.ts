/**
 * @axon/langchain — Drop-in LangChain tools backed by Axon.
 *
 *   import { Axon } from '@axon/client';
 *   import { axonTool, allAxonTools } from '@axon/langchain';
 *
 *   const axon = new Axon({ apiKey: process.env.AXON_KEY! });
 *
 *   // Single tool
 *   const search = axonTool(axon, 'serpapi', 'search', {
 *     name: 'web_search',
 *     description: 'Search the web via SerpAPI.',
 *     schema: z.object({ q: z.string() }),
 *   });
 *
 *   // All catalog APIs, auto-registered as tools
 *   const tools = await allAxonTools(axon);
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Axon } from '@axon/client';

export interface AxonToolOpts<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** If set, params go in query string (GET); otherwise body (POST). */
  via?: 'params' | 'body';
  /** Custom response shaper (default: JSON.stringify of the full data). */
  shape?: (data: unknown, meta: { cost: string; cacheHit: boolean }) => string;
}

export function axonTool<S extends z.ZodTypeAny>(
  axon: Axon,
  slug: string,
  endpoint: string,
  opts: AxonToolOpts<S>,
) {
  return tool(
    async (input: z.infer<S>) => {
      const via = opts.via ?? 'body';
      const result =
        via === 'params'
          ? await axon.call(slug, endpoint, input as any)
          : await axon.call(slug, endpoint, undefined, input);

      const shaped = opts.shape
        ? opts.shape(result.data, {
            cost: result.costUsdc,
            cacheHit: result.cacheHit,
          })
        : JSON.stringify(result.data);

      return shaped;
    },
    {
      name: opts.name,
      description: opts.description,
      schema: opts.schema,
    },
  );
}

/**
 * Fetch the Axon catalog and produce one LangChain tool per (api, endpoint).
 * Tool names: `${slug}__${endpoint}`.
 * Descriptions: sourced from API/endpoint metadata.
 *
 * Schemas are loose (`z.any()`) — override per-tool for strict typing.
 */
export async function allAxonTools(axon: Axon) {
  const apis = await axon.apis.list();
  const tools: ReturnType<typeof axonTool>[] = [];

  for (const api of apis) {
    for (const endpoint of api.endpoints) {
      tools.push(
        axonTool(axon, api.slug, endpoint, {
          name: `${api.slug}__${endpoint}`,
          description: `${api.provider} — ${api.category}: ${api.description}`,
          schema: z.record(z.any()).describe(
            `Input for ${api.slug}/${endpoint}. See ${api.homepage ?? api.slug} for param schema.`,
          ),
        }),
      );
    }
  }

  return tools;
}

export type { Axon } from '@axon/client';
