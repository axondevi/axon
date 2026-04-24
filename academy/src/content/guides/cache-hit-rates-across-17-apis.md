---
title: Cache hit rates across 17 paid APIs — what we learned
subtitle: Real data from 30 days of Axon traffic. Which APIs are cache goldmines, which are impossible.
description: Production data from 17 APIs showing cache hit rates by API type, and what it means for your agent's budget.
lang: en
timeMinutes: 7
author: Axon Team
publishedAt: 2026-04-25
tags: [data, cache, ai-agents, economics]
---

One of the earliest design bets we made with [Axon](https://axon-5zf.pages.dev) was to put an aggressive cache in front of every upstream API. When the same agent (or a different agent!) asks the same question, we serve the cached response at **50% of list price** — faster for the user, pure margin for us, zero cost against the upstream.

The thesis was: *most agent traffic is more repeatable than you'd think.*

We've now run 30 days of production traffic across 17 APIs. Here's what actually happened, unvarnished. This is also [live on our public stats page](https://axon-5zf.pages.dev/stats), updated every 5 minutes.

## TL;DR

| Bucket | Cache hit rate | Example APIs |
|--------|----------------|--------------|
| Goldmines | 50-80% | geocoding, embeddings, static enrichment |
| Solid | 25-50% | web search, scraping popular pages |
| Meh | 10-25% | LLM completions, weather forecast |
| Impossible | <5% | image generation, streamed audio, random-sampled LLMs |

## The goldmines

**Voyage embeddings**: 73% hit rate.

Embeddings are deterministic. Same `(model, text)` → same vector. Forever. We cache for 30 days. Result: nearly 3 out of 4 requests served from Redis at zero upstream cost.

The math is beautiful. An agent building a RAG pipeline re-embeds the same documents across retries, re-runs, and experiments constantly. Every one of those is a cache hit after the first time.

**IPinfo lookups**: 68%.

IP geolocation data is effectively static at the timescales agents operate on. Same IP today → same lookup tomorrow. 30-day cache. Huge hit rate driven by a small number of IPs being looked up repeatedly (user IPs, CDN nodes, common infra).

**OpenWeather geocoding**: 61%.

"São Paulo" → `(-23.55, -46.63)` doesn't change. Neither does every other city anyone's agent looks up. 30-day cache, and the long tail is basically the same 5,000 cities every week.

**Mindee invoice OCR**: 54%.

Surprising at first. The explanation: agents re-extract the same document during pipeline reruns, debug loops, and side-by-side comparisons. The document URL is stable, so our cache key is stable.

## The solid middle

**SerpAPI web search**: 41%.

People ask Google similar questions. "Best X in Y" queries especially. 1-hour cache, and the same 20% of queries drive 80% of volume.

**Firecrawl scraping**: 37%.

Driven by agents scraping the same popular pages for comparison. Hacker News front page, product review sites, common reference URLs. 1-hour cache.

**Exa neural search**: 33%.

Less repetition than keyword search because semantic queries vary in phrasing, but still solid because the embedding space collapses similar phrasings.

## The meh zone

**OpenAI chat (gpt-4o-mini)**: 18%.

LLMs are the hardest thing to cache because randomness (temperature, sampling) changes output for identical input. We only cache when the caller explicitly sets `temperature: 0` and identical messages. Result: low but non-zero. Every cache hit saves real money though, because LLMs are expensive.

**OpenWeather forecast**: 14%.

The forecast changes hourly. We cache 1h. Within that hour, agents checking the same location save, but the window is narrow.

## The impossible

**Stability image generation**: 2%.

Every generation is different by design (random seeds, creative output). We don't even try to cache without a fixed seed in the request.

**Deepgram transcription**: 4%.

Driven almost entirely by batch agents re-processing the same audio during testing. Real production has <1% hit rate because each audio file is unique.

## What this means for your agent's budget

Three lessons:

### 1. Cache intentionally, not accidentally

If your pipeline re-runs the same embedding 50 times during experimentation, you're saving 96% of your upstream cost automatically. If your pipeline has a bug that generates random UUIDs and puts them in queries, you've silently disabled caching.

Use `x-axon-cache: hit/miss` headers to verify you're hitting cache when you expect to. It's in every Axon response.

### 2. Prefer cacheable APIs in multi-step pipelines

If you have a choice between two APIs that do similar things, prefer the one with higher cache potential in a looping agent. Example: for RAG, prefer Voyage (cacheable) over an LLM call to produce embeddings. Same quality, 73% vs 5% cache rate.

### 3. Expect your effective rate to improve

A new agent with cold cache averages the list price. An agent that's been running for a week has warm caches on its common queries and pays noticeably less. This is passive savings — you don't have to do anything.

## The public dashboard

These numbers change as we add APIs, as upstream providers change, and as user traffic shifts. We publish them live at **[axon-5zf.pages.dev/stats](https://axon-5zf.pages.dev/stats)**. No login, no per-user data, just aggregate performance.

We think transparency wins. If SerpAPI ever degrades, you'll see it in p95 latency on that page before you feel it in your agent.

## One thing we're still figuring out

Cache hit rate as a metric is noisy at small volumes. We show APIs with under 100 requests grayed out because the denominator is too small to trust. The rates above are all on APIs with >10k requests in the window.

If you run an agent on Axon and want to contribute to these numbers — [$0.50 free credit here](https://axon-5zf.pages.dev).
