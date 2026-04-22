# Product Hunt Launch Kit

> Launch on a **Tuesday or Wednesday, 12:01 AM PT**. That's when the daily leaderboard resets. First 6 hours decide the day.

## Title (60 chars max)

**Primary:** `Axon — One wallet, every paid API your AI agent needs`

**Alternates if taken:**
- `Axon — Payment rails for the agent economy`
- `Axon — Stripe for AI agents, powered by USDC`

## Tagline (one sentence, 60 chars)

> Pay for any API in USDC, per request. Built on x402.

## Topics / categories

- Developer Tools (primary)
- Artificial Intelligence
- Crypto / Web3
- APIs
- SaaS

## Gallery (6 slots, in order of importance)

1. **Hero image** — the landing hero (1270×760). Bold headline + product shot of the catalog grid + dark background.
2. **30s demo GIF** — the shot 3 timelapse from the video script (agent making 4 calls with debit HUD).
3. **Catalog screenshot** — the logo wall section of the landing page, cropped clean.
4. **Dashboard screenshot** — admin/dashboard.html showing balance, usage, cache hit chart.
5. **Code snippet card** — 4 lines of TS, clean on dark. "This is your agent buying data."
6. **Framework support** — single graphic listing LangChain, crewAI, Autogen, PydanticAI, Vercel AI SDK, Mastra, Smolagents, n8n, MCP.

## First comment (posted by maker, under the launch post)

> Hey Product Hunt! Maker here.
>
> Short story: every AI agent I've built in the last 18 months has hit the same wall — the moment it needs to pay for an API. Credit cards don't work for agents. Monthly SaaS subscriptions assume humans. Manually juggling 20 API keys is a nightmare.
>
> x402 (HTTP 402 Payment Required, revived by Coinbase) fixes the payment layer: agents pay per request in USDC on-chain. But adoption is early and someone needs to be the aggregation layer — the Plaid of this.
>
> **Axon is that layer.**
>
> - 17 paid APIs live at launch (search, scraping, LLM, voice, enrichment, geo, embeddings…)
> - One USDC wallet on Base = one bill for all of them
> - Drop-in for LangChain, crewAI, Autogen, PydanticAI, Vercel AI SDK, Mastra, Smolagents, n8n, and MCP clients (Claude Desktop, Cursor, Zed)
> - Cached responses at 50% off list price — your agent gets cheaper as it works
> - Auto-refund on upstream failures (you never pay for a 500)
>
> **$5 free credit for the first 500 sign-ups today.** We're onboarding the first 100 builders personally — DM me with what you're building.
>
> Happy to answer anything. Roasts, "this is dumb because X", feature requests, all welcome.

## FAQ — draft answers to common PH comments

### "How is this different from OpenRouter?"
OpenRouter is great, and they're vertical — LLMs only. Axon is horizontal: LLMs *and* search *and* scraping *and* voice *and* enrichment *and* geo *and* whatever we add next. Different target user: not the chat app picking the cheapest LLM, but the autonomous agent that needs a dozen API categories behind one wallet.

### "Why on-chain? Why not just Stripe?"
Stripe is built for humans with cards. Agents need programmatic per-request settlement with no human in the loop. That's what x402 enables. Stablecoins (USDC) give agents a stable unit of account without the agent needing to understand crypto — they just deposit, we debit.

### "What stops my agent from draining my wallet?"
Three things: (1) your wallet balance is the hard ceiling, (2) every response returns `x-axon-cost-usdc` so you can log/alert/circuit-break, (3) the Policy Engine on Pro+ tiers lets you set per-request, per-day, and per-API caps.

### "Is this custodial? Where's my USDC?"
Custodial today via Coinbase CDP Wallets (SOC 2 compliant). Non-custodial via x402 native mode is live for advanced users who want to pay per-call directly from their own wallet with no pre-deposit.

### "How do you make money?"
Take-rate on each call (3-15% depending on tier), margin on cached responses, and optional Pro/Team subscriptions ($49/$199) for analytics, policy engine, and priority support. No listing fees for APIs — open catalog.

### "Can I self-host?"
Yes, it's open-source core. Run your own gateway, use our SDKs, BYO upstream keys. The commercial hosted version adds the Pro features and the pre-configured catalog.

### "What happens if an upstream API goes down?"
We support fallback routing: declare a fallback API in the registry config and Axon will transparently retry there on 5xx/429. You still only pay once. The public stats page shows real uptime/latency per API.

## Hunter strategy

- **Don't ask a big hunter to launch.** Self-hunt. PH's algorithm favors self-launches now and it shows authenticity.
- **Schedule ~2 weeks ahead.** Build anticipation with teasers on your Twitter and the Axon list.
- **Warm up your upvoters.** DM 20-30 friends, waitlist sign-ups, and early beta users the day before, ask for a morning upvote + a thoughtful comment.

## Day-of schedule

| Time (PT) | What |
|-----------|------|
| 00:00 | Launch goes live — automated |
| 00:05 | Post first comment (the one above) |
| 00:10 | Tweet the launch with the 30s demo GIF |
| 07:00 | Reply to every comment from overnight |
| 09:00 | Post in relevant Slacks/Discords (LangChain, crewAI, no-code builder groups) |
| 12:00 | Share in /r/LocalLLaMA, /r/AI_Agents with the blog post, NOT the PH link |
| 15:00 | LinkedIn post |
| 18:00 | Status update tweet: "Day 1 numbers: X signups, Y calls, Z cache hit rate" |

## What to avoid

- ❌ Vote manipulation (fake accounts, paid votes) — PH will shadowban
- ❌ Identical comments across multiple channels — algo detects, demotes
- ❌ "Please upvote me" DM spam — damages your credibility long-term
- ❌ Generic responses to comments — people can tell

## Success metric

Top 5 of the day = good. Top 3 = great. #1 = exceptional but not the goal.

**The real win is 300-500 signups in 48h and 10 enterprise conversations started.** That's worth more than the badge.
