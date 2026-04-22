# @axon/mastra

[Mastra](https://mastra.ai) tools backed by [Axon](https://axon.dev).

## Install

```bash
npm install @axon/mastra @axon/client zod
```

## Usage

```ts
import { Axon } from '@axon/client';
import { axonMastraTool } from '@axon/mastra';
import { Agent } from '@mastra/core';
import { z } from 'zod';

const axon = new Axon({ apiKey: process.env.AXON_KEY! });

const search = axonMastraTool(axon, 'serpapi', 'search', {
  id: 'web_search',
  description: 'Search the web via SerpAPI.',
  inputSchema: z.object({ q: z.string() }),
  via: 'params',
});

const agent = new Agent({
  name: 'researcher',
  instructions: 'You answer user questions with web research.',
  tools: { search },
});
```

## License

MIT
