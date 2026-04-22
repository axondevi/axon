// Agent loop using Vercel AI SDK + Axon — 4 tools behind one wallet.
//   AXON_KEY=ax_live_... OPENAI_API_KEY=sk-... bun vercel-ai-agent.ts "top AI news"
import { Axon } from '@axon/client';
import { axonTool } from '@axon/vercel-ai';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const axon = new Axon({ apiKey: process.env.AXON_KEY! });

const tools = {
  search: axonTool(axon, 'serpapi', 'search', {
    description: 'Google search',
    parameters: z.object({ q: z.string() }),
    via: 'params',
  }),
  scrape: axonTool(axon, 'firecrawl', 'scrape', {
    description: 'Scrape a URL as markdown',
    parameters: z.object({ url: z.string().url() }),
    via: 'body',
  }),
  news: axonTool(axon, 'brave-search', 'news', {
    description: 'Latest news articles',
    parameters: z.object({ q: z.string() }),
    via: 'params',
  }),
  embed: axonTool(axon, 'voyage', 'embeddings', {
    description: 'Compute semantic embeddings (voyage-3)',
    parameters: z.object({
      input: z.array(z.string()),
      model: z.string().default('voyage-3'),
    }),
    via: 'body',
  }),
};

const question = process.argv.slice(2).join(' ') || 'top AI news today';

const { text } = await generateText({
  model: openai('gpt-4o-mini'),
  tools,
  maxSteps: 8,
  system: 'Research. Cite sources. Use the cheapest tool that answers.',
  prompt: question,
});

console.log(text);
const bal = await axon.wallet.balance();
console.log(`\n→ wallet: ${bal.available_usdc} USDC available`);
