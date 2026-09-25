import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { migrate } from '../../packages/db/src/migrate.js';
import { createPool } from '../../packages/db/src/pool.js';

const pool = createPool(
  process.env.TEST_DATABASE_URL ?? 'postgres://relay:relay_local@localhost:55432/relay',
);

afterAll(async () => {
  await pool.end();
});

it('applies migrations once under concurrent startup', async () => {
  await Promise.all([migrate(pool), migrate(pool)]);

  const applied = await pool.query('SELECT version FROM schema_migrations');
  expect(applied.rows).toHaveLength(2);

  const tables = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  expect(tables.rows.map((row) => row.table_name)).toContain('deliveries');
});

it('rolls back failed migrations and rejects checksum drift', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-migrations-'));
  try {
    // The table is created before the failing statement; the rollback must remove it.
    await writeFile(
      join(directory, '999_failure.sql'),
      'CREATE TABLE rollback_probe (id int); SELECT missing_function();',
    );
    await expect(migrate(pool, directory)).rejects.toThrow();

    const probe = await pool.query<{ name: string | null }>(
      "SELECT to_regclass('rollback_probe') AS name",
    );
    expect(probe.rows[0]?.name).toBeNull();

    // Same version as the real initial migration, but with different content.
    await writeFile(join(directory, '001_initial.sql'), 'SELECT 1;');
    await expect(migrate(pool, directory)).rejects.toThrow('checksum mismatch');
  } finally {
    await rm(directory, { recursive: true });
  }
});
