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
  // Treasury default is the zero address — sending USDC there literally
  // burns it. Refuse to boot in production unless an actual address is
  // configured.
  if (
    data.NODE_ENV === 'production' &&
    data.TREASURY_ADDRESS === '0x0000000000000000000000000000000000000000'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TREASURY_ADDRESS'],
      message:
        'TREASURY_ADDRESS must be set in production — the zero-address default would burn settlement transfers.',
    });
  }
  // WALLET_PROVIDER=placeholder is fine for local/dev but silently spawns
  // fake wallets in prod. Force an explicit choice.
  if (data.NODE_ENV === 'production' && data.WALLET_PROVIDER === 'placeholder') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WALLET_PROVIDER'],
      message:
        'WALLET_PROVIDER=placeholder is not allowed in production. Choose cdp or turnkey.',
    });
  }
  // If the operator picks a wallet provider, require its credentials at
  // boot rather than first-request. Saves a 500 in prod.
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

export function upstreamKeyFor(slug: string): string | undefined {
  const envKey = `UPSTREAM_KEY_${slug.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envKey];
}
