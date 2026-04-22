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

  WALLET_PROVIDER: z.enum(['placeholder', 'cdp']).default('placeholder'),
  CDP_API_KEY_NAME: z.string().optional(),
  CDP_API_KEY_PRIVATE: z.string().optional(),
  CDP_NETWORK_ID: z.string().default('base-mainnet'),

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
