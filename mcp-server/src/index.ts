#!/usr/bin/env node
/**
 * Axon MCP Server
 *
 * Exposes every API in the Axon catalog as an MCP tool. Install in Claude
 * Desktop, Claude Code, Cursor, Zed, or any MCP-compatible client and every
 * paid API becomes a callable tool with one wallet, one key, per-request
 * USDC billing.
 *
 * Env:
 *   AXON_KEY        required — your ax_live_ key
 *   AXON_BASE_URL   optional — defaults to https://api.axon.dev
 *   AXON_APIS       optional — comma-separated slugs to expose; if empty,
 *                   all catalog entries are exposed.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Axon, AxonError } from '@axon/client';

const apiKey = process.env.AXON_KEY;
if (!apiKey) {
  console.error(
    'AXON_KEY environment variable required. Get one at https://axon.dev',
  );
  process.exit(1);
}

const baseUrl = process.env.AXON_BASE_URL ?? 'https://api.axon.dev';
const filterSlugs = process.env.AXON_APIS?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const axon = new Axon({ apiKey, baseUrl });

interface ToolDef {
  name: string;
  description: string;
  slug: string;
  endpoint: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    additionalProperties: boolean;
  };
}

let toolsCache: ToolDef[] | null = null;

async function loadTools(): Promise<ToolDef[]> {
  if (toolsCache) return toolsCache;

  const apis = await axon.apis.list();
  const filtered = filterSlugs
    ? apis.filter((a) => filterSlugs.includes(a.slug))
    : apis;

  const tools: ToolDef[] = [];

  for (const api of filtered) {
    for (const endpoint of api.endpoints) {
      tools.push({
        name: `${api.slug}__${endpoint}`,
        description: `${api.provider} · ${api.category}: ${api.description} (endpoint: ${endpoint})`,
        slug: api.slug,
        endpoint,
        inputSchema: {
          type: 'object',
          properties: {
            // Loose schema: accept any object of string/number/bool.
            // MCP clients (Claude) will fill from context.
          },
          additionalProperties: true,
        },
      });
    }
  }

  // Built-in utility tools
  tools.push({
    name: 'axon__balance',
    description:
      'Check your Axon wallet balance (USDC on Base). Returns available + reserved funds.',
    slug: '__builtin__',
    endpoint: 'balance',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });

  tools.push({
    name: 'axon__catalog',
    description: 'List every API available through this Axon gateway.',
    slug: '__builtin__',
    endpoint: 'catalog',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });

  toolsCache = tools;
  return tools;
}

const server = new Server(
  { name: 'axon-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await loadTools();
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tools = await loadTools();
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
  }

  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    // Built-ins
    if (tool.slug === '__builtin__') {
      if (tool.endpoint === 'balance') {
        const b = await axon.wallet.balance();
        return {
          content: [
            {
              type: 'text',
              text: `Available: ${b.available_usdc} USDC · Reserved: ${b.reserved_usdc} USDC · Address: ${b.address}`,
            },
          ],
        };
      }
      if (tool.endpoint === 'catalog') {
        const apis = await axon.apis.list();
        return {
          content: [{ type: 'text', text: JSON.stringify(apis, null, 2) }],
        };
      }
    }

    // Regular Axon call. Split args into params (scalars) vs body (objects/arrays).
    const params: Record<string, string | number | boolean> = {};
    let body: Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'object' && v !== null) {
        body = body ?? {};
        body[k] = v;
      } else if (
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean'
      ) {
        params[k] = v;
      }
    }

    // If any body fields, send as POST; otherwise GET with params.
    const result = body
      ? await axon.call(tool.slug, tool.endpoint, undefined, { ...params, ...body })
      : await axon.call(tool.slug, tool.endpoint, params);

    const preview =
      typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data, null, 2);

    return {
      content: [
        {
          type: 'text',
          text:
            `[${tool.slug}/${tool.endpoint}] paid ${result.costUsdc} USDC · cache ${result.cacheHit ? 'hit' : 'miss'}\n\n` +
            preview,
        },
      ],
    };
  } catch (err) {
    if (err instanceof AxonError) {
      throw new McpError(
        ErrorCode.InternalError,
        `Axon error (${err.code}): ${err.message}`,
      );
    }
    throw err;
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('axon-mcp ready (stdio transport)');
}

main().catch((err) => {
  console.error('axon-mcp fatal error:', err);
  process.exit(1);
});
