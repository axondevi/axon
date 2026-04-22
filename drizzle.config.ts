import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://axon:axon@localhost:5432/axon',
  },
  strict: true,
  verbose: true,
} satisfies Config;
