# WhatsApp disconnected

## Symptoms

- A specific agent's WhatsApp connection shows `status='disabled'`
  or `status='pairing'` indefinitely.
- Customer messages no longer trigger replies.
- Owner pulls open the dashboard and sees the connection card red.

## Diagnose

```bash
# Inspect the connection state for the affected agent
curl -H "X-API-Key: $AXON_KEY" \
  "https://axon-kedb.onrender.com/v1/agents/<id>/whatsapp"
```

The response includes `status`, `last_event_at`, `paired_phone`.

| Status | Meaning |
|---|---|
| `pairing` | QR was generated but never scanned |
| `connecting` | QR scanned, Evolution still pairing |
| `connected` | Active and receiving |
| `disabled` | Owner muted the connection deliberately |

## Remediation

### A. Stuck in `pairing`
QR codes expire after ~60 seconds. Re-trigger:

```bash
curl -X POST -H "X-API-Key: $AXON_KEY" \
  "https://axon-kedb.onrender.com/v1/agents/<id>/whatsapp/refresh-qr"
```

Owner re-scans in WhatsApp → `Linked devices`.

### B. `connected` but no inbound
Most likely Evolution lost its WhatsApp websocket and didn't tell us.

1. Check Evolution health:
   ```bash
   curl -sf "$AXON_EVOLUTION_URL/" | head -c 100
   ```
   - 200 → Evolution itself is up
   - non-2xx → Evolution down; restart its Render service

2. Look at `last_event_at`. If older than 30 min and the customer
   confirms they sent something: probably a webhook delivery failure.
   Re-pair (delete + recreate connection).

### C. `disabled` and no one knows why
Look at `admin_audit_log` filtering on action like `whatsapp.%`:

```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  "https://axon-kedb.onrender.com/v1/admin/audit?action=whatsapp.disable"
```

If a user did it deliberately (paused for vacation), unpause via
the dashboard. If it was triggered by Evolution stopping —
reconnect.

## Replay risk

Every inbound webhook payload is dedup'd by Evolution message id
in Redis for 10 min. If the path-secret leaks, an attacker has at
most a 10-minute window to replay the same payload. To rotate:

1. Delete the connection (cleanup deletes the Evolution instance).
2. Re-create — generates a fresh `webhook_secret`.

The customer has to scan the QR again on their phone.

## What is broken during outage

- Inbound replies (the user-facing complaint)
- `human_paused_until` won't kick in for new owner-typed replies

## Recovery verification

Send a message to the agent's WhatsApp number from a different phone.
You should see in Render logs within seconds:

```
INFO  http  path=/v1/webhooks/whatsapp/<secret> status=200
INFO  agent_run  agent_id=<id>  reply_chars=N
```

Then check the customer's WhatsApp for the reply.
