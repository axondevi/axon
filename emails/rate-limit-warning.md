---
subject: Your agent hit rate limits ({{hits}} times this hour)
preheader: Free tier caps at 10 req/min. Pro ($49/mo) = 600/min.
vars: [name, hits, tier, upgrade_url]
---

Hey {{name}},

Over the last hour your agent hit the rate limit **{{hits}} times**. Every one of those returned 429 and the agent had to retry.

You're on the **{{tier}}** tier, which allows 10 req/min. Two options:

1. **Slow the agent down** — add a backoff in your code. The headers `x-ratelimit-remaining` and `x-ratelimit-reset` tell you when to retry.

2. **Upgrade to Pro** ($49/mo): 600 req/min, priority routing, 5% markup instead of 15%, and aggressive cache. Most users break even at ~3000 req/day.

[Upgrade here]({{upgrade_url}}) — or just reply to this email and I'll set you up manually.

— Axon
