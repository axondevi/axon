# axon-client

Official Python client for [Axon](https://axon.dev).

## Install

```bash
pip install axon-client
```

## Quick start

```python
from axon import Axon

axon = Axon(api_key="ax_live_...")

# GET with params
result = axon.call("serpapi", "search", params={"q": "espresso in lisbon"})
print(result.data, result.cost_usdc, result.cache_hit)

# POST with body
chat = axon.call("openai", "chat", body={
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}],
})

# Wallet
print(axon.wallet.balance())

# Catalog
for api in axon.apis.list():
    print(api["slug"], api["category"])
```

## Error handling

```python
from axon import Axon, AxonError

try:
    axon.call("serpapi", "search", params={"q": "..."})
except AxonError as e:
    if e.code == "insufficient_funds":
        ...
```

## Env vars

- `AXON_KEY` — your API key (used if `api_key` not passed)
- `AXON_BASE_URL` — override for self-hosted / staging

## License

MIT
