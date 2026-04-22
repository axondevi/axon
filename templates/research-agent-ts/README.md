# Research Agent — TypeScript

Agent that searches the web, scrapes the top results, and synthesizes a cited answer. ~50 lines of code.

## Run

```bash
bun install
AXON_KEY=ax_live_... OPENAI_API_KEY=sk-... bun start "what are the top espresso bars in lisbon?"
```

Output:

```
Researching: what are the top espresso bars in lisbon?

────────────────────────────────────────────────────────────
1. Copenhagen Coffee Lab — reliably excellent beans, …
2. Hello, Kristof — minimalist space, high-end extraction, …
...
Sources:
- https://...
- https://...
────────────────────────────────────────────────────────────
Wallet now: 24.943000 USDC available
```

## What makes this different from "normal" tool-using agents?

- **One API key** (`AXON_KEY`) drives SerpAPI, Firecrawl, and everything else
- **Pay per request** — no monthly SerpAPI bill, no Firecrawl subscription
- **Cache aware** — the second run of the same question hits caches and costs ~50% less
- **Wallet visible** — the agent can check `axon.wallet.balance()` and budget itself
