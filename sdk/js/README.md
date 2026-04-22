# @axon/client

Official TypeScript client for [Axon](https://axon.dev) — the universal API gateway for AI agents.

## Install

```bash
npm install @axon/client
# or
bun add @axon/client
```

## Quick start

```ts
import { Axon } from '@axon/client';

const axon = new Axon({ apiKey: process.env.AXON_KEY! });

// Call any API in the catalog
const { data, costUsdc, cacheHit } = await axon.call(
  'serpapi',
  'search',
  { q: 'best espresso in lisbon' },
);

console.log(`Paid ${costUsdc} USDC, cache ${cacheHit ? 'hit' : 'miss'}`);

// POST calls (body)
const chat = await axon.call('openai', 'chat', undefined, {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello!' }],
});

// Wallet
const balance = await axon.wallet.balance();
console.log(balance.available_usdc);

// Catalog
const apis = await axon.apis.list();
```

## Error handling

```ts
import { AxonError } from '@axon/client';

try {
  await axon.call('serpapi', 'search', { q: '...' });
} catch (e) {
  if (e instanceof AxonError) {
    if (e.code === 'insufficient_funds') {
      // top up wallet
    }
  }
}
```

## Options

| Option | Default | Purpose |
|--------|---------|---------|
| `apiKey` | — | Your Axon API key (starts with `ax_live_`) |
| `baseUrl` | `https://api.axon.dev` | Override for self-hosted / staging |
| `fetch` | `globalThis.fetch` | Injectable for tests / edge runtimes |
| `userAgent` | `@axon/client/0.1` | Custom UA header |

## License

MIT
