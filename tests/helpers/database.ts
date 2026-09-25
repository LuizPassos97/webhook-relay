import { randomBytes } from 'node:crypto';
import pg, { type Pool } from 'pg';
import { migrate } from '../../packages/db/src/migrate.js';
import { createPool } from '../../packages/db/src/pool.js';

export const BASE_TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://relay:relay_local@localhost:55432/relay';

export interface TestDatabase {
  url: string;
  pool: Pool;
  drop(): Promise<void>;
}

/**
 * Creates and migrates a throwaway database.
 * Worker tests claim every due delivery in a database, so they need one of their own.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `relay_test_${randomBytes(6).toString('hex')}`;
  await runAdminQuery(`CREATE DATABASE ${name}`);

  const url = new URL(BASE_TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  await migrate(pool);

  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      await runAdminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

async function runAdminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: BASE_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Polls `condition` until it returns true, instead of sleeping for a fixed time. */
export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  { timeoutMs = 10_000, intervalMs = 20 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
