---
subject: Axon wallet low — {{balance}} USDC remaining
preheader: At current usage your agent will hit insufficient_funds in ~{{hours_remaining}}h.
vars: [name, balance, hours_remaining, deposit_address, recent_usage_usdc]
---

Hey {{name}},

Heads-up: your Axon wallet is at **{{balance}} USDC**.

Over the last 24h your agent spent about {{recent_usage_usdc}} USDC. At that rate, you'll hit insufficient funds in roughly **{{hours_remaining}}** hours.

### Top up

Send USDC on Base to:

```
{{deposit_address}}
```

1-block confirmation. You'll get an email when it lands.

### Budget your agent

If you'd rather cap spending instead, set a policy:

```
curl -X PUT https://api.axon.dev/v1/admin/policy/<user_id> \
  -H "x-admin-key: <your admin key>" \
  -d '{"daily_budget_micro": "5000000"}'
```

$5/day hard cap. Agent gets 403 above that.

— Axon
