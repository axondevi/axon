---
name: API catalog request
about: Ask us to add an upstream API to the catalog
labels: api-request
title: "[API] <provider name>"
---

## API details

- **Provider**: (e.g. Clearbit, Mindee)
- **Homepage**: https://...
- **Docs**: https://...

## Why this belongs in Axon

- Who would use it:
- What agents would benefit:

## Pricing model

- Base price per call: $___
- Does it have a free tier? (helpful for people evaluating Axon)
- How's the pricing structured? (per call / per token / tiered)

## Auth type

- [ ] Bearer token
- [ ] Header with custom name
- [ ] Query string parameter
- [ ] Other (describe)

## Endpoints to include

List the endpoints that would be most valuable, their HTTP method, and approximate cache TTL:

- `POST /v1/...` — description — cacheable? — suggested TTL
- `GET /v2/...` — description — cacheable? — suggested TTL

## Anything else

Rate limits, gotchas, idempotency quirks, etc.
