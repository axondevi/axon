# ElevenLabs blocked / banned

## Symptoms

- `/v1/voices/<id>/preview.mp3` returns 402 with
  `voice_provider_unavailable`.
- WhatsApp voice replies stop arriving — text replies still come.
- Render logs show
  `voice.synthesize.api_error status=401 body="…detected_unusual_activity…"`

## Cause

ElevenLabs blocks free-tier API requests originating from datacenter
or VPN IPs. Render egress shares IPs across customers; the moment
one of them gets flagged, every Axon call from Render is rejected.

## Mitigations (in order of preference)

### 1. Upgrade the ElevenLabs account
The cleanest fix. $5/mo Starter plan removes the datacenter block.

1. Log in to https://elevenlabs.io
2. Subscription → Upgrade → Starter
3. The same `ELEVENLABS_API_KEY` immediately starts working — no
   redeploy needed; the next call goes through.

### 2. Generate a new API key on the upgraded account
If for any reason the existing key is tainted (revoked, leaked,
shared with another project), generate a new one in the ElevenLabs
profile settings and rotate via Render env:

```bash
curl -X PUT \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"value\":\"$NEW_KEY\"}" \
  "https://api.render.com/v1/services/$SERVICE_ID/env-vars/ELEVENLABS_API_KEY"
```

(Render auto-redeploys.)

### 3. Switch provider (large change)
If ElevenLabs becomes hostile or expensive, swap to Cartesia or
Deepgram Aura. Code change confined to `src/voice/elevenlabs.ts`
and the route in `src/routes/voices.ts`. Out of scope for incident
response — file an issue and follow normal change process.

## Live degradation

While the provider is blocked:
- **Voice OUT** silently degrades to text-only. Customers who sent
  audio get a text reply with the agent's words. Functional but
  off-brand.
- **Voice picker preview** shows a 402 toast in the dashboard. Users
  can still pick a voice; preview just doesn't play.
- **Voice cloning** also fails (same provider). Block the cloning
  UI in the dashboard temporarily if the outage is long.

## Verification once fixed

```bash
curl -i -H "X-API-Key: $AXON_KEY" \
  https://axon-kedb.onrender.com/v1/voices/XrExE9yKIg1WjnnlVkGX/preview.mp3 \
  -o /tmp/preview.mp3
file /tmp/preview.mp3
# → audio/mpeg or "MPEG ADTS, layer III"
```

## Postmortem

- [ ] How was it detected? (Render logs / user report / monitor?)
- [ ] If user-reported: add a counter to `/metrics` so future
      occurrences page automatically.
- [ ] Update billing reminder so the plan doesn't lapse.
