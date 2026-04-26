/**
 * Server-side agent runtime.
 *
 * Customers (mobile apps, backend services, n8n flows, anything that can
 * speak HTTP) hit POST /v1/run/:slug/chat with a single message or a
 * messages array, and the server runs the FULL agent loop here:
 *   1. Build system prompt + Groq tools array from agent.allowed_tools
 *   2. Call Groq with stream=false (we want a clean JSON response)
 *   3. If the model returned tool_calls, execute each via handleCall()
 *      (which respects cache, fallbacks, metering, request logging)
 *   4. Append tool results, loop until model produces a content-only
 *      message OR we hit max iterations
 *   5. Return the final assistant text + a summary of tools executed
 *
 * Tool definitions live here (mirroring landing/dashboard.html TOOL_DEFS
 * but only network-backed tools — local tools like calculate / run_js
 * make no sense in a server-only context, the model can do basic math).
 */
import type { Context } from 'hono';
import { handleCall } from '~/wrapper/engine';
import { TOOL_TO_AXON } from '~/agents/templates';
import { upstreamKeyFor } from '~/config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ToolDef {
  description: string;
  parameters: Record<string, unknown>;
  /** Transform LLM args → upstream params/body. Defaults to identity. */
  buildRequest?: (args: any) => { params?: Record<string, unknown>; body?: unknown };
}

export const SERVER_TOOLS: Record<string, ToolDef> = {
  lookup_cnpj: {
    description: 'Look up a Brazilian company by CNPJ.',
    parameters: { type: 'object', properties: { cnpj: { type: 'string' } }, required: ['cnpj'] },
    buildRequest: (a) => ({ params: { cnpj: String(a.cnpj).replace(/\D/g, '') } }),
  },
  lookup_cep: {
    description: 'Look up a Brazilian postal code.',
    parameters: { type: 'object', properties: { cep: { type: 'string' } }, required: ['cep'] },
    buildRequest: (a) => ({ params: { cep: String(a.cep).replace(/\D/g, '') } }),
  },
  current_weather: {
    description: 'Current weather for a city.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    buildRequest: (a) => ({ params: { q: a.q } }),
  },
  weather_forecast: {
    description: 'Multi-day weather forecast by lat/lon.',
    parameters: {
      type: 'object',
      properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, forecast_days: { type: 'integer' } },
      required: ['latitude', 'longitude'],
    },
    buildRequest: (a) => ({
      params: {
        latitude: a.latitude,
        longitude: a.longitude,
        current: 'temperature_2m,weather_code,wind_speed_10m',
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
        forecast_days: a.forecast_days || 3,
        timezone: 'auto',
      },
    }),
  },
  lookup_ip: {
    description: 'IP geolocation + ISP lookup.',
    parameters: { type: 'object', properties: { ip: { type: 'string' } }, required: ['ip'] },
    buildRequest: (a) => ({ params: { ip: a.ip } }),
  },
  lookup_country: {
    description: 'World country data — population, capital, currencies, languages.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    buildRequest: (a) => ({ params: { name: a.name, fields: 'name,capital,population,currencies,languages,region,flag' } }),
  },
  brasilapi_holidays: {
    description: 'Brazilian national holidays for a year.',
    parameters: { type: 'object', properties: { year: { type: 'integer' } }, required: ['year'] },
    buildRequest: (a) => ({ params: { ano: String(a.year) } }),
  },
  brasilapi_rates: {
    description: 'Current Selic / CDI / IPCA.',
    parameters: { type: 'object', properties: {} },
    buildRequest: () => ({ params: {} }),
  },
  brasilapi_ddd: {
    description: 'Brazilian phone area code → state + cities.',
    parameters: { type: 'object', properties: { ddd: { type: 'string' } }, required: ['ddd'] },
    buildRequest: (a) => ({ params: { ddd: String(a.ddd).replace(/\D/g, '') } }),
  },
  convert_currency: {
    description: 'FX conversion via ECB rates (Frankfurter).',
    parameters: {
      type: 'object',
      properties: { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
      required: ['amount', 'from', 'to'],
    },
    buildRequest: (a) => ({
      params: { amount: a.amount, base: String(a.from || '').toUpperCase(), symbols: String(a.to || '').toUpperCase() },
    }),
  },
  crypto_price: {
    description: 'Current crypto prices via CoinGecko.',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'string' }, vs_currencies: { type: 'string' } },
      required: ['ids'],
    },
    buildRequest: (a) => ({
      params: {
        ids: String(a.ids || '').toLowerCase(),
        vs_currencies: String(a.vs_currencies || 'usd,brl').toLowerCase(),
        include_24hr_change: 'true',
      },
    }),
  },
  search_web: {
    description: 'Tavily web search — broad queries, news.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, max_results: { type: 'integer' } },
      required: ['query'],
    },
    buildRequest: (a) => ({ body: { query: a.query, max_results: a.max_results || 3, search_depth: 'basic' } }),
  },
  exa_search: {
    description: 'Exa neural search — semantic + technical.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, num_results: { type: 'integer' } },
      required: ['query'],
    },
    buildRequest: (a) => ({ body: { query: a.query, numResults: a.num_results || 5, type: 'auto' } }),
  },
  scrape_url: {
    description: 'Fetch any URL as clean markdown (Firecrawl).',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    buildRequest: (a) => ({ body: { url: a.url, formats: ['markdown'], onlyMainContent: true } }),
  },
  search_hn: {
    description: 'Search Hacker News.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, hitsPerPage: { type: 'integer' } },
      required: ['query'],
    },
    buildRequest: (a) => ({ params: { query: a.query, tags: 'story', hitsPerPage: a.hitsPerPage || 5 } }),
  },
  wikipedia_summary: {
    description: 'Wikipedia article summary (lead paragraph).',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    buildRequest: (a) => ({ params: { title: String(a.title || '').replace(/ /g, '_') } }),
  },
  wikipedia_search: {
    description: 'Search Wikipedia.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    },
    buildRequest: (a) => ({
      params: { action: 'query', list: 'search', srsearch: a.query, srlimit: a.limit || 5, format: 'json', origin: '*' },
    }),
  },
  embed_text: {
    description: 'Generate a 512-dim embedding (Voyage AI).',
    parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
    buildRequest: (a) => ({ body: { input: a.input, model: 'voyage-3-lite' } }),
  },
};

export function buildToolsArray(allowedTools: string[]): any[] {
  return allowedTools
    .filter((name) => SERVER_TOOLS[name] && TOOL_TO_AXON[name])
    .map((name) => ({
      type: 'function',
      function: {
        name,
        description: SERVER_TOOLS[name].description,
        parameters: SERVER_TOOLS[name].parameters,
      },
    }));
}

interface RunAgentResult {
  content: string;
  tool_calls_executed: Array<{
    name: string;
    args: Record<string, unknown>;
    ok: boolean;
    cost_usdc: string;
    error?: string;
  }>;
  iterations: number;
  finish_reason: 'stop' | 'max_iterations' | 'error';
  total_cost_usdc: string;
}

const MAX_ITERATIONS = 8;
const MAX_TOOL_RESULT_CHARS = 6000;

/**
 * Run the agent loop server-side. Caller has already loaded the agent +
 * checked auth/budget/tier — this function focuses purely on the LLM
 * conversation + tool execution.
 */
export async function runAgent(opts: {
  c: Context;
  systemPrompt: string;
  allowedTools: string[];
  messages: ChatMessage[];
  ownerId: string;
}): Promise<RunAgentResult> {
  const { c, systemPrompt, allowedTools, messages, ownerId } = opts;

  const tools = buildToolsArray(allowedTools);
  const toolList = allowedTools
    .filter((t) => SERVER_TOOLS[t])
    .map((t) => `- ${t}: ${SERVER_TOOLS[t].description}`)
    .join('\n');

  const fullSystemPrompt = [
    systemPrompt,
    '',
    '## Language',
    "Reply in the same language the user wrote in (PT/EN/ES/etc). Mirror their language for the entire turn.",
    '',
    tools.length ? '## Tools available' : '',
    toolList,
    '',
    'Current date: ' + new Date().toISOString().slice(0, 10) + '.',
  ]
    .filter(Boolean)
    .join('\n');

  // Convo history with system prompt prepended
  const history: ChatMessage[] = [{ role: 'system', content: fullSystemPrompt }, ...messages];
  const toolCallsExecuted: RunAgentResult['tool_calls_executed'] = [];
  let totalCostMicro = 0n;

  const groqKey = upstreamKeyFor('groq');
  if (!groqKey) {
    throw new Error('UPSTREAM_KEY_GROQ not configured — agent runtime needs Groq');
  }

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Direct Groq call (we already paid the wallet via /v1/run gate)
    const llmReq: any = {
      model: 'llama-3.3-70b-versatile',
      messages: history,
      max_tokens: 4096,
      temperature: 0.3,
    };
    if (tools.length) {
      llmReq.tools = tools;
      llmReq.tool_choice = 'auto';
    }

    const llmRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(llmReq),
    });

    if (!llmRes.ok) {
      const text = await llmRes.text().catch(() => '');
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch {}
      const m = (parsed && (parsed.message || (parsed.error && parsed.error.message))) || `groq ${llmRes.status}`;
      throw new Error(m);
    }
    const llmJson = await llmRes.json();
    const choice = llmJson.choices?.[0];
    if (!choice) throw new Error('No response from model');
    const msg: ChatMessage = choice.message ?? {};

    history.push(msg);

    const tcs = msg.tool_calls ?? [];
    if (tcs.length === 0) {
      return {
        content: String(msg.content ?? ''),
        tool_calls_executed: toolCallsExecuted,
        iterations: iter + 1,
        finish_reason: 'stop',
        total_cost_usdc: (Number(totalCostMicro) / 1_000_000).toFixed(6),
      };
    }

    // Execute each tool call by delegating to handleCall with explicit overrides.
    // The wallet was already conceptually committed at the agent-run gate;
    // engine still debits per-call so the costs are real.
    for (const tc of tcs) {
      let args: any;
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }

      const upstream = TOOL_TO_AXON[tc.function.name];
      const def = SERVER_TOOLS[tc.function.name];
      if (!upstream || !def) {
        const err = `Tool '${tc.function.name}' is not server-runnable.`;
        toolCallsExecuted.push({ name: tc.function.name, args, ok: false, cost_usdc: '0', error: err });
        history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: err }) });
        continue;
      }

      const built = def.buildRequest ? def.buildRequest(args) : { params: args };

      try {
        const upstreamRes = await handleCall(c, {
          slug: upstream.api,
          endpoint: upstream.endpoint,
          paramsOverride: built.params ?? {},
          bodyOverride: built.body,
        });
        const cost = parseFloat(upstreamRes.headers.get('x-axon-cost-usdc') || '0') || 0;
        totalCostMicro += BigInt(Math.round(cost * 1_000_000));
        const cloned = upstreamRes.clone();
        const text = await cloned.text();
        const truncated = text.slice(0, MAX_TOOL_RESULT_CHARS);
        toolCallsExecuted.push({
          name: tc.function.name,
          args,
          ok: upstreamRes.ok,
          cost_usdc: cost.toFixed(6),
        });
        history.push({ role: 'tool', tool_call_id: tc.id, content: truncated });
      } catch (err: any) {
        toolCallsExecuted.push({
          name: tc.function.name,
          args,
          ok: false,
          cost_usdc: '0',
          error: err.message || String(err),
        });
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: err.message || String(err) }),
        });
      }
    }
    // Loop continues — model gets the tool results and may call more tools or finalize
  }

  return {
    content: '(max iterations reached without final answer)',
    tool_calls_executed: toolCallsExecuted,
    iterations: MAX_ITERATIONS,
    finish_reason: 'max_iterations',
    total_cost_usdc: (Number(totalCostMicro) / 1_000_000).toFixed(6),
  };
}
