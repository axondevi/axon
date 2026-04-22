# Axon Starter Templates

Clone-and-run examples. Each template takes 2 minutes to be useful.

| Template | Stack | What it does |
|----------|-------|--------------|
| [research-agent-ts](./research-agent-ts) | TypeScript · Vercel AI SDK · Axon | Agent that researches a topic: searches the web, scrapes top results, summarizes |
| [research-agent-python](./research-agent-python) | Python · LangChain · Axon | Same as above but in LangChain |
| [n8n-workflow](./n8n-workflow) | n8n no-code | Cron → search → scrape → summarize → Slack |

## Prerequisites (all templates)

1. Axon API key (`ax_live_…`) — get one at [axon.dev](https://axon.dev)
2. Wallet funded with some USDC — `axon wallet:deposit-intent` to get the address
3. LLM provider for your agent framework (OpenAI, Anthropic, etc.)

All API keys for scraping/search are handled by Axon — you don't need to sign up for SerpAPI, Firecrawl, etc. individually.
