# Outbound Webhooks

Axon POSTs JSON events to URLs you register. Useful for:
- Slack/Discord alerts when deposits arrive
- Alerting on `balance.low` so you can top up before the agent blocks
- Audit logs for policy denials
- Billing integrations (refund notifications)

## Supported events

| Event | When it fires |
|-------|---------------|
| `deposit.received` | A deposit hits your custodial wallet (on-chain confirmed) |
| `balance.low` | Balance drops below a threshold you configure (roadmap) |
| `policy.denied` | A call was blocked by a policy rule |
| `call.refunded` | Auto-refund after an upstream failure or metering reconciliation |
| `rate_limit.hit` | Your tier's rate limit was exceeded |
| `wallet.reserved_exceeds_balance` | Internal reservation exceeded balance (reconciliation bug detector) |

## Registering a subscription

```bash
curl -X POST https://axon-kedb.onrender.com/v1/webhook-subscriptions \
  -H "x-api-key: ax_live_..." \
  -H "content-type: application/json" \
  -d '{
    "url": "https://hooks.slack.com/services/XXX/YYY/ZZZ",
    "events": ["deposit.received", "call.refunded"]
  }'
```

Response includes a `secret` used to verify signatures. **Save it** — it's not retrievable later.

```json
{
  "id": "sub_uuid",
  "url": "...",
  "events": ["deposit.received", "call.refunded"],
  "secret": "whsec_abc123...",
  "warning": "Save the secret now..."
}
```

## Listing / deleting subscriptions

```bash
curl https://axon-kedb.onrender.com/v1/webhook-subscriptions -H "x-api-key: ..."
curl -X DELETE https://axon-kedb.onrender.com/v1/webhook-subscriptions/<id> -H "x-api-key: ..."
```

## Delivery format

Axon POSTs to your URL with:

```
Content-Type: application/json
User-Agent: Axon-Webhook/0.1
X-Axon-Event: deposit.received
X-Axon-Delivery-Id: <uuid>
X-Axon-Signature: sha256=<hex>
```

Body:

```json
{
  "id": "<uuid>",
  "event": "deposit.received",
  "created_at": "2026-04-21T10:00:00Z",
  "user_id": "<uuid>",
  "data": {
    "amount_usdc": "25.000000",
    "new_balance_usdc": "50.000000",
    "onchain_tx": "0xabc..."
  }
}
```

## Verifying signatures

Compute `HMAC-SHA256(secret, raw_body)` and compare (constant-time) to the hex in `X-Axon-Signature`.

### Node

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string): boolean {
  const sent = header.replace(/^sha256=/, '');
  const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return timingSafeEqual(Buffer.from(sent, 'hex'), Buffer.from(computed, 'hex'));
}
```

### Python

```python
import hmac, hashlib

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    sent = header.removeprefix("sha256=")
    computed = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sent, computed)
```

## Idempotency

Every delivery has a unique `X-Axon-Delivery-Id`. If you see the same ID twice (retries), treat it as one event. We persist delivery attempts server-side.

## Inspecting delivery logs

```bash
curl https://axon-kedb.onrender.com/v1/webhook-subscriptions/<id>/deliveries -H "x-api-key: ..."
```

Returns the last 50 attempts with status/error so you can debug why something didn't fire.

## Retry behavior (v0.1)

Single attempt, 10 second timeout, no automatic retry. Failed deliveries are recorded; we plan exponential backoff retries in v0.2. For now, consume via a queue (SQS, Slack/Discord webhook URL) that's already resilient.
