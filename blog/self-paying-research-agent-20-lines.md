---
title: Build a self-paying research agent in 20 lines
slug: self-paying-research-agent-20-lines
description: A working agent that searches the web, scrapes, and synthesizes — charging its own USDC wallet per call. No SerpAPI signup. No Firecrawl subscription.
tags: [tutorial, ai-agents, vercel-ai-sdk, axon]
published_at: 2026-04-23
reading_time: 6
---

# Build a self-paying research agent in 20 lines

By the end of this post you'll have a research agent that:
- Searches the web via SerpAPI
- Scrapes the top results via Firecrawl
- Synthesizes a cited answer via GPT-4o-mini
- Pays for every single call out of its own USDC wallet on Base
- Costs you ~**$0.04 per question**

No SerpAPI account. No Firecrawl subscription. No manual API key juggling.

## Prerequisites

```bash
bun add @axon/client @axon/vercel-ai @ai-sdk/openai ai zod
```

And two env vars:
- `AXON_KEY` — [sign up for free $5 credit](https://axon.dev) to get one
- `OPENAI_API_KEY` — for the LLM driving the agent

## The whole agent

```ts
import { Axon } from '@axon/client';
import { axonTool } from '@axon/vercel-ai';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const axon = new Axon({ apiKey: process.env.AXON_KEY! });

const search = axonTool(axon, 'serpapi', 'search', {
  description: 'Search the web.',
  parameters: z.object({ q: z.string() }),
  via: 'params',
});

const scrape = axonTool(axon, 'firecrawl', 'scrape', {
  description: 'Scrape a URL, return markdown.',
  parameters: z.object({ url: z.string().url() }),
  via: 'body',
});

const { text } = await generateText({
  model: openai('gpt-4o-mini'),
  tools: { search, scrape },
  maxSteps: 8,
  system: 'Search, scrape 2-3 top links, synthesize with source URLs.',
  prompt: process.argv.slice(2).join(' '),
});

console.log(text);
```

## What just happened

Three moving parts:

**1. Axon wraps paid APIs.** `axonTool(axon, 'serpapi', 'search', ...)` creates a Vercel AI SDK tool that, when called, hits Axon → SerpAPI → back. You never see a SerpAPI key. The cost is debited from your Axon wallet in USDC.

**2. The LLM picks which tool to call and when.** `generateText` with `tools:` and `maxSteps: 8` lets the LLM decide: call `search`, look at results, call `scrape` on the most promising, summarize. This is the ReAct pattern you already know from LangChain.

**3. The wallet makes it autonomous.** Every call debits USDC atomically. If the agent tries to spend more than you deposited, Axon returns `402 insufficient_funds` and the agent stops. You set a budget, the agent works within it.

## Running it

```bash
AXON_KEY=ax_live_... OPENAI_API_KEY=sk-... \
  bun agent.ts "what are the top espresso bars in lisbon?"
```

Output:

```
1. Copenhagen Coffee Lab — reliably excellent beans, …
2. Hello, Kristof — minimalist space, high-end extraction, …
3. Fábrica Coffee Roasters — single-origin specialists, …

Sources:
- https://timeout.com/lisbon/coffee-spots
- https://eater.com/2025/lisbon-coffee-guide
- …
```

## What you actually paid

Axon returns `x-axon-cost-usdc` on every call. Typical run:
- 1× search  = $0.0055
- 3× scrape  = $0.0165
- 4× LLM     = $0.0080 (gpt-4o-mini is cheap)
- **Total: ~$0.03**

Run the same question an hour later → SerpAPI result comes from cache at 50% off, most scrapes from cache too. Second run: **~$0.015**.

Compare:
- SerpAPI minimum plan: $50/mo
- Firecrawl minimum plan: $16/mo
- Combined monthly minimum: **$66/mo**

To break even on the subscription model you'd need to run ~2,200 of these agents per month. Most indie hackers don't.

## What stops the agent from burning your wallet

Two things by default, one upgrade for paranoid builders:

1. **Your wallet balance is the hard ceiling.** An agent with a $5 wallet cannot spend $6. Full stop.
2. **Every response returns `x-axon-cost-usdc`.** You can log it, alert on it, write circuit breakers.
3. **(Pro tier)** Policy engine: `max_request_cost_micro`, `daily_budget_micro`, per-API caps. Your agent can rampage within limits you set.

## Going further

- Swap `gpt-4o-mini` for `claude-sonnet-4-6` via `@ai-sdk/anthropic` — Axon bills both through the same wallet
- Add `axon.call('voyage', 'embeddings', ...)` to build a RAG layer on top
- Cache the whole agent loop: same question in 5 minutes = 80% cache hit = ~$0.005

## The full template

Cloneable repo at [`axondev/axon` → `templates/research-agent-ts`](https://github.com/axondev/axon/tree/main/templates/research-agent-ts). Runs out of the box.

If you build something on this, I'd love to see it — DM [@axondev](https://twitter.com/axondev).
