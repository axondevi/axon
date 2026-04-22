# Quickstart

Get your agent paying for APIs in **under 5 minutes**.

## 1. Create an account

Hit the admin endpoint (on your self-hosted instance) or sign up at [axon.dev](https://axon.dev).

Either way you receive:

```
api_key          = ax_live_abc123…
deposit_address  = 0x…
balance_usdc     = 5.000000
```

**Save the API key — it's shown once and never again.**

## 2. Install the SDK

### TypeScript / JavaScript

```bash
npm install @axon/client
```

### Python

```bash
pip install axon-client
```

## 3. Make your first call

### TS

```ts
import { Axon } from '@axon/client';

const axon = new Axon({ apiKey: process.env.AXON_KEY! });

const { data, costUsdc, cacheHit } = await axon.call(
  'serpapi',
  'search',
  { q: 'best espresso in lisbon' },
);

console.log(data);
console.log(`paid ${costUsdc} USDC, cache ${cacheHit ? 'hit' : 'miss'}`);
```

### Python

```python
from axon import Axon

axon = Axon(api_key="ax_live_...")
result = axon.call("serpapi", "search", params={"q": "best espresso in lisbon"})
print(result.data)
print(f"paid {result.cost_usdc} USDC, cache {'hit' if result.cache_hit else 'miss'}")
```

### curl

```bash
curl "https://api.axon.dev/v1/call/serpapi/search?q=best+espresso+in+lisbon" \
  -H "x-api-key: ax_live_..." -i
```

Response includes three Axon-specific headers:

- `x-axon-cost-usdc` — what you paid
- `x-axon-cache` — `hit` or `miss`
- `x-axon-latency-ms` — end-to-end time

## 4. Top up your wallet

```ts
const { deposit_address } = await axon.wallet.depositIntent();
// Send USDC on Base L2 to this address. Credits arrive in 1 confirmation.
```

Chain: **Base mainnet**. Asset: **USDC** (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).

## 5. Hook into an agent

### LangChain (TS)

```ts
import { allAxonTools } from '@axon/langchain';
import { createReactAgent } from '@langchain/langgraph/prebuilt';

const tools = await allAxonTools(axon);
const agent = createReactAgent({ llm, tools });
```

### LangChain (Python)

```python
from axon_langchain import all_axon_tools
from langgraph.prebuilt import create_react_agent

tools = all_axon_tools(axon)
agent = create_react_agent(llm, tools)
```

That's it — your agent can now autonomously call any API in the catalog.

## Next

- [API reference](./api-reference.md)
- [Adding a new upstream API](./adding-apis.md)
- [Architecture overview](./architecture.md)
