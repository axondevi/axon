/**
 * Applies Drizzle migrations from ./drizzle to the configured database.
 * Run via: `bun run db:migrate`
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { env } from '~/config';

async function main() {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool);

  console.log('[migrate] applying migrations from ./drizzle …');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('[migrate] done.');

  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
