/**
 * x402 native payment mode.
 *
 * Default mode is prepaid wallet (user deposits USDC, we debit internally).
 * When ENABLE_X402_NATIVE=true and a request arrives WITHOUT an x-api-key
 * header, we respond 402 Payment Required with payment requirements and
 * the client pays on-chain per request. After verifying the payment we
 * execute the call with no wallet debit.
 *
 * Docs: https://x402.org
 * Install: bun add x402
 *
 * This middleware is lazy-loaded — the `x402` package is an optional dep.
 */

import type { Context, Next } from 'hono';
import { env } from '~/config';

// The real middleware is only loaded when both flags are set.
const ENABLE = process.env.ENABLE_X402_NATIVE === 'true';

interface X402Mod {
  paymentMiddleware: (opts: {
    receivingWallet: string;
    price: string;
    asset: string;
    chain: string;
    description?: string;
  }) => (c: Context, next: Next) => Promise<Response | void>;
}

let x402Pkg: X402Mod | null = null;

async function loadX402(): Promise<X402Mod> {
  if (x402Pkg) return x402Pkg;
  try {
    // @ts-ignore — optional dep
    const mod = await import('x402/hono');
    x402Pkg = mod as unknown as X402Mod;
    return x402Pkg;
  } catch {
    throw new Error(
      'x402 native mode requires the `x402` package.\n' +
        '  bun add x402\n' +
        'Or disable it: ENABLE_X402_NATIVE=false',
    );
  }
}

/**
 * x402Middleware — gate the `/v1/call/*` route when native mode is on and
 * the caller did NOT authenticate with an API key (prepaid wallet mode).
 *
 * If ENABLE_X402_NATIVE=false → no-op, pass through to the prepaid wallet
 * auth middleware.
 *
 * The price per call is taken from the registry entry (see engine.ts).
 * The receiving wallet is env.TREASURY_ADDRESS.
 */
export async function x402Middleware(c: Context, next: Next) {
  if (!ENABLE) return next();

  const hasApiKey = !!c.req.header('x-api-key');
  if (hasApiKey) {
    // Prepaid wallet mode — let the normal auth middleware handle this.
    return next();
  }

  if (
    env.TREASURY_ADDRESS === '0x0000000000000000000000000000000000000000'
  ) {
    return c.json(
      {
        error: 'x402_misconfigured',
        message:
          'TREASURY_ADDRESS is not set. x402 native mode cannot accept payments.',
      },
      500,
    );
  }

  // Resolve price from the URL. Expected path: /v1/call/:slug/:endpoint
  const url = new URL(c.req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // ['v1', 'call', slug, endpoint]
  if (parts.length < 4 || parts[0] !== 'v1' || parts[1] !== 'call') {
    return next();
  }
  const slug = parts[2];
  const endpointKey = parts[3];

  const { getApi } = await import('~/registry/apis');
  const api = getApi(slug);
  const endpoint = api?.endpoints[endpointKey];
  if (!api || !endpoint) {
    return c.json({ error: 'not_found', message: 'Unknown API' }, 404);
  }

  const effectivePriceUsd =
    endpoint.price_usd * (1 + endpoint.markup_pct / 100);

  const { paymentMiddleware } = await loadX402();
  const mw = paymentMiddleware({
    receivingWallet: env.TREASURY_ADDRESS,
    price: `$${effectivePriceUsd.toFixed(6)}`,
    asset: 'USDC',
    chain: 'base',
    description: `Axon: ${api.provider} · ${endpointKey}`,
  });

  // Flag so the engine knows to skip internal wallet debit.
  c.set('axon:x402_paid', true);
  return mw(c, next);
}
