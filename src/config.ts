import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  MASTER_ENCRYPTION_KEY: z
    .string()
    .min(32, 'MASTER_ENCRYPTION_KEY must be at least 32 chars'),
  ADMIN_API_KEY: z.string().min(32, 'ADMIN_API_KEY must be at least 32 chars'),

  BASE_RPC_URL: z.string().default('https://mainnet.base.org'),
  USDC_ADDRESS: z
    .string()
    .default('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  TREASURY_ADDRESS: z.string().default(
    '0x0000000000000000000000000000000000000000',
  ),

  ALCHEMY_WEBHOOK_SIGNING_KEY: z.string().optional(),
  DEPOSIT_WEBHOOK_TOKEN: z.string().optional(),

  WALLET_PROVIDER: z.enum(['placeholder', 'cdp', 'turnkey']).default('placeholder'),
  CDP_API_KEY_NAME: z.string().optional(),
  CDP_API_KEY_PRIVATE: z.string().optional(),
  CDP_NETWORK_ID: z.string().default('base-mainnet'),

  TURNKEY_API_PUBLIC_KEY: z.string().optional(),
  TURNKEY_API_PRIVATE_KEY: z.string().optional(),
  TURNKEY_ORGANIZATION_ID: z.string().optional(),
  TURNKEY_API_BASE_URL: z.string().default('https://api.turnkey.com'),

  ENABLE_X402_NATIVE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  METRICS_TOKEN: z.string().optional(),

  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('https://axon-5zf.pages.dev')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === 'production' && !data.METRICS_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['METRICS_TOKEN'],
      message:
        'METRICS_TOKEN is required in production — /metrics exposes wallet balances.',
    });
  }
  // The TREASURY_ADDRESS / WALLET_PROVIDER / wallet-cred combinations
  // below are checked at boot, but only HARD-fail when the affected
  // feature is actually live. Otherwise we log a warning so a fresh
  // deploy still boots and the operator sees the gap. Hard-fail
  // conditions:
  //   - TREASURY zero AND ENABLE_X402_NATIVE=true (x402 settles to it)
  //   - WALLET_PROVIDER=cdp without CDP creds (first user signup crashes)
  //   - WALLET_PROVIDER=turnkey without Turnkey creds (ditto)
  // Soft-warn:
  //   - TREASURY zero in prod (no x402 yet — caller will see it before
  //     turning x402 on)
  //   - WALLET_PROVIDER=placeholder in prod (signup hands out fake wallet
  //     addresses that can't receive deposits, but doesn't crash)
  if (
    data.NODE_ENV === 'production' &&
    data.TREASURY_ADDRESS === '0x0000000000000000000000000000000000000000' &&
    data.ENABLE_X402_NATIVE
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TREASURY_ADDRESS'],
      message:
        'TREASURY_ADDRESS must be set when ENABLE_X402_NATIVE=true — settlement to the zero address burns funds.',
    });
  }
  if (data.WALLET_PROVIDER === 'cdp') {
    if (!data.CDP_API_KEY_NAME || !data.CDP_API_KEY_PRIVATE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CDP_API_KEY_NAME'],
        message:
          'WALLET_PROVIDER=cdp requires CDP_API_KEY_NAME and CDP_API_KEY_PRIVATE.',
      });
    }
  }
  if (data.WALLET_PROVIDER === 'turnkey') {
    if (
      !data.TURNKEY_API_PUBLIC_KEY ||
      !data.TURNKEY_API_PRIVATE_KEY ||
      !data.TURNKEY_ORGANIZATION_ID
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TURNKEY_API_PUBLIC_KEY'],
        message:
          'WALLET_PROVIDER=turnkey requires TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID.',
      });
    }
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

// Soft warnings — log loudly so the operator sees them in deploy logs but
// don't refuse to boot. These are footguns, not blockers.
if (env.NODE_ENV === 'production') {
  if (env.TREASURY_ADDRESS === '0x0000000000000000000000000000000000000000') {
    console.warn(
      '[config] WARNING: TREASURY_ADDRESS is the zero address. x402 settlement transfers would burn funds. Set it before flipping ENABLE_X402_NATIVE on.',
    );
  }
  if (env.WALLET_PROVIDER === 'placeholder') {
    console.warn(
      '[config] WARNING: WALLET_PROVIDER=placeholder in production. Signup hands out fake wallet addresses that cannot receive deposits. Set WALLET_PROVIDER=cdp or =turnkey before going live.',
    );
  }
}

/**
 * Several upstream services are touched in TWO places: the gateway proxy
 * (`/v1/call/<slug>/...`) and the agent runtime (`src/voice/*`,
 * `src/llm/vision.ts`). Historically those used different env names —
 * the gateway expects `UPSTREAM_KEY_<SLUG>`, the runtime expects the
 * vendor's natural name (`ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`,
 * `GEMINI_API_KEY`). Operators only configured one and the other path
 * silently 502'd.
 *
 * This list maps each `UPSTREAM_KEY_<SLUG>` lookup to a fallback
 * vendor-natural name. Set EITHER and both call paths work.
 */
const UPSTREAM_KEY_ALIASES: Record<string, string[]> = {
  ELEVENLABS: ['ELEVENLABS_API_KEY'],
  DEEPGRAM: ['DEEPGRAM_API_KEY'],
  GEMINI: ['GEMINI_API_KEY'],
  GROQ: ['GROQ_API_KEY'],
  OPENAI: ['OPENAI_API_KEY'],
  ANTHROPIC: ['ANTHROPIC_API_KEY'],
  COHERE: ['COHERE_API_KEY'],
  MISTRAL: ['MISTRAL_API_KEY'],
  PERPLEXITY: ['PERPLEXITY_API_KEY'],
  REPLICATE: ['REPLICATE_API_TOKEN', 'REPLICATE_API_KEY'],
  STABILITY: ['STABILITY_API_KEY'],
  CARTESIA: ['CARTESIA_API_KEY'],
  ASSEMBLYAI: ['ASSEMBLYAI_API_KEY'],
};

export function upstreamKeyFor(slug: string): string | undefined {
  const upper = slug.toUpperCase().replace(/-/g, '_');
  const primary = process.env[`UPSTREAM_KEY_${upper}`];
  if (primary) return primary;
  for (const fallback of UPSTREAM_KEY_ALIASES[upper] ?? []) {
    const v = process.env[fallback];
    if (v) return v;
  }
  return undefined;
}
