/**
 * Axon research agent (TS)
 *
 *   bun src/index.ts "what are the top espresso bars in lisbon?"
 *
 * Requires in env:
 *   AXON_KEY         — your ax_live_ key
 *   OPENAI_API_KEY   — for the LLM that drives the agent
 */
import { Axon } from '@axon/client';
import { axonTool } from '@axon/vercel-ai';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const axon = new Axon({ apiKey: process.env.AXON_KEY! });

const search = axonTool(axon, 'serpapi', 'search', {
  description: 'Search the web. Returns organic results with title, link, snippet.',
  parameters: z.object({
    q: z.string().describe('Search query'),
  }),
  via: 'params',
});

const scrape = axonTool(axon, 'firecrawl', 'scrape', {
  description: 'Scrape a single URL and return clean markdown.',
  parameters: z.object({
    url: z.string().url(),
    formats: z.array(z.enum(['markdown'])).default(['markdown']),
  }),
  via: 'body',
});

async function main() {
  const question = process.argv.slice(2).join(' ') || 'top AI news today';
  console.log(`\nResearching: ${question}\n`);

  const { text } = await generateText({
    model: openai('gpt-4o-mini'),
    tools: { search, scrape },
    maxSteps: 8,
    system: [
      'You are a research agent. Answer the user question by:',
      '1) Searching the web with `search`.',
      '2) Picking 2-3 promising links and scraping them with `scrape`.',
      '3) Synthesizing a concise, cited answer.',
      'Always include source URLs.',
    ].join('\n'),
    prompt: question,
  });

  const bal = await axon.wallet.balance();

  console.log('─'.repeat(60));
  console.log(text);
  console.log('─'.repeat(60));
  console.log(`Wallet now: ${bal.available_usdc} USDC available`);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
