---
subject: Deposit received — {{amount}} USDC added
preheader: Your Axon wallet now has {{new_balance}} USDC available.
vars: [name, amount, new_balance, onchain_tx]
---

Hey {{name}},

Your deposit landed.

- **Amount**: {{amount}} USDC
- **New balance**: {{new_balance}} USDC
- **On-chain tx**: {{onchain_tx}}

Your agent can keep calling — no action needed from you.

If you want to receive this programmatically, register a webhook for `deposit.received`:

```
curl -X POST https://axon-kedb.onrender.com/v1/webhook-subscriptions \
  -H "x-api-key: ax_live_..." \
  -H "content-type: application/json" \
  -d '{"url":"https://your-endpoint","events":["deposit.received"]}'
```

— Axon
