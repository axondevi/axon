# Spec — Agent Chat on Client Dashboard

**Status:** proposed, not yet built. Target: Phase 2 of the dashboard-UX work started 2026-04-24.

## Why this exists

Axon is positioned as an API gateway for AI agents that others build. That
positions the value out of reach of anyone who is not already writing agent
code. Adding a chat interface that runs *as an agent* on the user's own
wallet flips the positioning:

> "Axon is the agent you can use right now, and it shows you exactly how it
> works — every API call, every cached hit, every cent spent."

This turns the dashboard from a billing screen into a product demo and a
live onboarding experience. It's also self-funded: every conversation
spends from the user's own wallet (calling `openai` or `anthropic` via Axon
itself), so we don't subsidize inference.

## UX sketch

```
┌────────────────────────────────────────────────────────────────────┐
│  axon · dashboard                                                  │
├────────────────────────────────────────────────────────────────────┤
│  (existing deposit hero / metrics / try-a-call stay above)         │
│                                                                    │
│  ┌──────────────────────────────┬───────────────────────────────┐  │
│  │ CHAT                         │ BRAIN                         │  │
│  │                              │                               │  │
│  │ [user] Tell me about CNPJ    │ 🧠 Reasoning…                 │  │
│  │  00.000.000/0001-91 and the  │                               │  │
│  │  weather in its home city.   │ 🔧 tool_call                  │  │
│  │                              │    brasilapi.cnpj             │  │
│  │ [agent] Banco do Brasil SA,  │    { cnpj: "000..." }         │  │
│  │ based in Brasília. Right now │    ⚡ $0.001 · cache HIT      │  │
│  │ it's 297.2°C(?) with broken  │    279ms                      │  │
│  │ clouds.                      │                               │  │
│  │                              │ 🔧 tool_call                  │  │
│  │ ask anything… [Run]          │    openweather.current        │  │
│  │                              │    { q: "Brasília" }          │  │
│  │                              │    ⚡ $0.0006 · MISS · 421ms  │  │
│  │                              │                               │  │
│  │                              │ Session: 3 calls · $0.0022    │  │
│  │                              │ Cache saved: $0.0005          │  │
│  └──────────────────────────────┴───────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

Key properties:

- **Two-panel**: chat on left, "agent brain" on right. Brain is read-only
  observation of what the agent is doing.
- **Live streaming**: both the LLM response and tool-call events stream in
  as they happen. Brain panel grows in real time.
- **Session metrics**: footer of brain panel shows "this session" totals —
  calls, cost, cache savings. Reinforces Axon economics.
- **No orchestrator on server**: the frontend runs the tool-use loop,
  calling OpenAI (or Anthropic) via Axon and executing tool calls against
  Axon. Keeps server-side footprint zero.

## Scope — MVP

### In scope
- Chat UI (user + assistant bubbles)
- Brain panel listing tool_calls with cost/latency/cache-hit metadata
- Session aggregate counters
- Fixed set of ~6 tools mapped to Axon APIs:
  - `lookup_cnpj` → `brasilapi/cnpj`
  - `lookup_cep` → `brasilapi/cep`
  - `current_weather` → `openweather/current`
  - `search_web` → `tavily/search` (fallback: `exa/search`)
  - `lookup_ip` → `ipinfo/lookup`
  - `embed_text` → `voyage/embed`
- Uses the user's own API key to call `openai/chat/completions` via Axon
  (`v1/call/openai/chat`). User pays for inference from their wallet.
- Model hardcoded to `gpt-4o-mini` (cheapest capable w/ function calling).
  Configurable later.
- A "Stop" button to halt in-flight tool calls.
- System prompt primed to use the tools and explain what it's doing.

### Out of scope for MVP
- Multi-turn tool use with complex branching (MVP does 1-3 tool calls max
  per user turn; if LLM wants more, it gets truncated).
- Message persistence (session-only; page refresh resets).
- Anthropic / other model support (add later, OpenAI first).
- Streaming of LLM text mid-generation (we accept full responses).
- Voice input/output.
- File upload.
- Agent memory across sessions.
- Configurable model / temperature / tool set.

## Safety rails (non-negotiable for MVP)

1. **Per-session spend cap.** Before each tool call, check cumulative
   session spend. If > $0.50, pause and require user confirmation to
   continue. Hard cap at $2.00 per session.
2. **Tool-call count cap.** Max 10 tool calls per user turn. Prevents
   runaway loops.
3. **Request timeout.** Any individual tool call must complete in < 15s.
4. **No tool that spends without bound.** Exclude `replicate`, `runway`,
   `stability` from MVP tool set — their per-call costs are variable and
   can spike.
5. **No tool that returns binary large payloads.** Exclude `firecrawl`
   scrape, `deepgram` transcribe from MVP — would blow up context window.
6. **User-side confirmation on first run.** First time a user opens the
   chat in a session, show a one-time modal: "This chat uses your Axon
   wallet. Each message costs ~$0.001-$0.01. Cap is $0.50 per session."

## Architecture

```
Browser (dashboard.html)
 ├─ UI state: messages[], toolCalls[], sessionSpend
 └─ Loop:
      1. user submits message
      2. POST to Axon → openai/chat/completions with:
         { model, messages, tools: AXON_TOOLS }
         via `Authorization: Bearer <user-api-key>`
      3. If response has `tool_calls`:
           for each tool_call:
             render in brain panel as "pending"
             execute: POST to Axon → `<mapped-api>/<endpoint>` with args
             capture x-axon-cost-usdc, x-axon-cache, x-axon-latency-ms
             render in brain panel as completed
             append tool_result to messages
           loop back to step 2 (with cap at 10 iterations)
      4. Else render final assistant message in chat
```

No backend changes required. Everything runs client-side against existing
Axon endpoints.

## Tool schema (OpenAI function-calling format)

```js
const AXON_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'lookup_cnpj',
      description: 'Look up a Brazilian company by CNPJ (corporate tax ID). Returns legal name, address, status, shareholders.',
      parameters: {
        type: 'object',
        properties: {
          cnpj: { type: 'string', description: 'CNPJ number, 14 digits, no punctuation' }
        },
        required: ['cnpj']
      }
    },
    axon: { api: 'brasilapi', endpoint: 'cnpj', paramStyle: 'query' }
  },
  {
    type: 'function',
    function: {
      name: 'lookup_cep',
      description: 'Look up a Brazilian postal code (CEP). Returns street, neighborhood, city, state.',
      parameters: {
        type: 'object',
        properties: {
          cep: { type: 'string', description: 'CEP, 8 digits, no dash' }
        },
        required: ['cep']
      }
    },
    axon: { api: 'brasilapi', endpoint: 'cep', paramStyle: 'query' }
  },
  {
    type: 'function',
    function: {
      name: 'current_weather',
      description: 'Get current weather for a city. Returns temperature in Kelvin, conditions, humidity, wind.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'City name, optionally with country code (e.g. "São Paulo, BR")' }
        },
        required: ['q']
      }
    },
    axon: { api: 'openweather', endpoint: 'current', paramStyle: 'query' }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the web via Tavily. Returns a list of results with titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          max_results: { type: 'integer', default: 3 }
        },
        required: ['query']
      }
    },
    axon: { api: 'tavily', endpoint: 'search', paramStyle: 'body' }
  },
  {
    type: 'function',
    function: {
      name: 'lookup_ip',
      description: 'Look up geolocation and owner of an IPv4 or IPv6 address.',
      parameters: {
        type: 'object',
        properties: {
          ip: { type: 'string' }
        },
        required: ['ip']
      }
    },
    axon: { api: 'ipinfo', endpoint: 'lookup', paramStyle: 'query' }
  },
  {
    type: 'function',
    function: {
      name: 'embed_text',
      description: 'Generate an embedding vector (1024 dims) for a short text input using Voyage AI.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' }
        },
        required: ['input']
      }
    },
    axon: { api: 'voyage', endpoint: 'embed', paramStyle: 'body' }
  }
];
```

## System prompt

```
You are an assistant running inside the Axon dashboard — an API gateway
for AI agents. You have access to a small set of tools (CNPJ lookup, CEP
lookup, weather, web search, IP info, embeddings) powered by Axon.

When answering, prefer using tools to ground your answer in fresh data.
Be concise. Show numbers. Acknowledge when a tool fails.

You are running on the user's own wallet. Each tool call costs them
$0.0003–$0.01. Do not call more tools than needed to answer the
question.

Never call the same tool with the same arguments twice in one turn.
```

## Open questions (decide before building)

1. **Which LLM provider by default?** OpenAI `gpt-4o-mini` is cheapest
   (~$0.15/1M input tokens, $0.60/1M output). Anthropic `haiku-4-5` is
   comparable and Axon routes it natively. Recommend Anthropic as the
   *native* Axon story — eat our own dogfood.
2. **Where to store OPENAI_KEY / ANTHROPIC_KEY for the call?** The user
   doesn't have their own — they pay Axon and Axon has the upstream key.
   Use the existing `v1/call/{api}/...` path which Axon already authenticates.
3. **Model streaming?** OpenAI supports SSE, Anthropic too. MVP can skip
   streaming (wait for full response) — simpler and good enough for
   3-5-second responses.
4. **Tool-call UI while pending?** Spinner row with "calling…" plus the
   params. When response lands, replace with completed row including cost
   chip + cache-hit badge.
5. **When to reset the session counters?** On page load only (SPA-style),
   or also on explicit "New chat" button? MVP: both.
6. **Rate limiting by Axon.** The free tier is 10 req/min. A chat that
   does 3 tool calls per turn hits this at 3-4 messages/min. MVP should
   gracefully show a "slow down" message; the dashboard already sees 429
   from the Axon side.

## Estimated build time

1-2 full days of focused work:

- Day 1 (~6h): UI scaffolding, two-panel layout, message rendering,
  tool-call dispatch loop, cost tracking
- Day 2 (~4-6h): safety rails, first-run modal, polish, testing on mobile,
  empty states, error handling

## Done criteria

- [ ] User with $0.50 bonus can have a 5-10 message conversation that
      uses 3+ different tools without running out.
- [ ] Brain panel shows every tool call with cost and cache status.
- [ ] Session hits $0.50 spend cap and pauses for confirmation.
- [ ] Page refresh resets session cleanly.
- [ ] Works on mobile viewport (stacks chat above brain, both scrollable).
- [ ] Gracefully handles 429, 500, and network errors from any tool call.
- [ ] No uncaught promise rejections in console.

## Stretch — Phase 2.5

Once MVP ships, natural extensions (don't scope into Phase 2):

- Configurable tool set (user toggles which tools the agent can access)
- Message persistence via localStorage (survive refresh)
- Multi-model: switch between gpt-4o-mini, haiku, sonnet at runtime
- Streaming LLM responses
- Memory layer — previous conversations summarized and injected as context
- "Share this conversation" export → URL with readonly transcript + cost
