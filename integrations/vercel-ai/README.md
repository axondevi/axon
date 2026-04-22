# @axon/vercel-ai

[Vercel AI SDK](https://sdk.vercel.ai) tools backed by [Axon](https://axon.dev).

## Install

```bash
npm install @axon/vercel-ai @axon/client ai zod
```

## Usage

```ts
import { Axon } from '@axon/client';
import { axonTool, axonToolset } from '@axon/vercel-ai';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const axon = new Axon({ apiKey: process.env.AXON_KEY! });

// ─── Strongly-typed single tool ───────────────
const search = axonTool(axon, 'serpapi', 'search', {
  description: 'Search the web for up-to-date information.',
  parameters: z.object({
    q: z.string().describe('Search query'),
  }),
  via: 'params',
});

const { text } = await generateText({
  model: openai('gpt-4o-mini'),
  tools: { search },
  prompt: 'What is the top AI news today?',
});

// ─── Or load the entire Axon catalog as tools ─
const allTools = await axonToolset(axon, z);
const { text } = await generateText({
  model: openai('gpt-4o-mini'),
  tools: allTools,
  prompt: 'Find the top 3 espresso bars in Lisbon and summarize reviews.',
});
```

## Metadata on every call

Every tool result includes `_meta.cost_usdc`, `_meta.cache_hit`, and `_meta.latency_ms` so your agent (and your analytics) can reason about spend.

## License

MIT
