# n8n Workflow — Daily News Research

Cron → search → split → scrape → aggregate → summarize. Every 8 hours.

## Prerequisites

1. Self-hosted n8n with the `n8n-nodes-axon` community node installed (see [`integrations/n8n`](../../integrations/n8n))
2. Axon credentials configured in n8n (API key)

## Import

1. n8n → **Workflows** → **Import from file** → pick `workflow.json`
2. Verify the Axon credential is attached to each Axon node
3. Change the search query in the **Search (Axon)** node if you want
4. Enable the workflow

## What it does

1. Triggers every 8h (adjust in the Schedule node)
2. Searches Google for "AI agent news today" via Axon → SerpAPI
3. Splits the top 5 results
4. Scrapes each link via Axon → Firecrawl
5. Aggregates scraped markdown
6. Summarizes via Axon → OpenAI (gpt-4o-mini)

Add a Slack, Telegram, or email node at the end to push the summary.

## Cost per run (ballpark)

- 1× search (~$0.005)
- 5× scrape (~$0.025)
- 1× LLM summary (~$0.01)
- **Total: ~$0.04 / run = ~$0.12 / day = ~$3.60 / month**

Compare to subscriptions:
- SerpAPI: $50/mo minimum
- Firecrawl: $16/mo minimum
- OpenAI: pay-as-you-go (same)

**15× cheaper, zero per-vendor setup.**
