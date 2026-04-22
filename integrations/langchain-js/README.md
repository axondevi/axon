# @axon/langchain

Drop-in [LangChain.js](https://js.langchain.com) tools backed by Axon. Turn any paid API into an agent tool in one line — no per-vendor keys, no subscriptions, per-request USDC billing.

## Install

```bash
npm install @axon/langchain @axon/client
```

## Usage

### Single tool, strongly typed

```ts
import { Axon } from '@axon/client';
import { axonTool } from '@axon/langchain';
import { ChatOpenAI } from '@langchain/openai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';

const axon = new Axon({ apiKey: process.env.AXON_KEY! });

const webSearch = axonTool(axon, 'serpapi', 'search', {
  name: 'web_search',
  description: 'Search the web for up-to-date results.',
  via: 'params',
  schema: z.object({
    q: z.string().describe('The search query'),
  }),
});

const agent = createReactAgent({
  llm: new ChatOpenAI({ model: 'gpt-4o-mini' }),
  tools: [webSearch],
});

const res = await agent.invoke({
  messages: [{ role: 'user', content: 'What was the top news today?' }],
});
```

### Auto-register every API in the catalog

```ts
import { allAxonTools } from '@axon/langchain';

const tools = await allAxonTools(axon);

const agent = createReactAgent({
  llm: new ChatOpenAI({ model: 'gpt-4o-mini' }),
  tools, // agent can now use any API in the Axon catalog
});
```

## Why this is different from raw API tools

- **One wallet** — all tools charge against the same USDC balance
- **Cost telemetry** — every tool call surfaces `costUsdc` and `cacheHit` via Axon's headers
- **Automatic refunds** — failed upstream calls don't debit your wallet
- **Cache** — repeated tool calls (same params) cost 50% less

## License

MIT
