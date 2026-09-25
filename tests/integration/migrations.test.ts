import { afterAll, it, expect } from 'vitest';
import { createPool } from '../../packages/db/src/pool.js';
import { migrate } from '../../packages/db/src/migrate.js';
const pool = createPool(process.env.TEST_DATABASE_URL ?? 'postgres://relay:relay_local@localhost:55432/relay');
afterAll(() => pool.end());
it('applies migrations once under concurrent startup', async () => {
  await Promise.all([migrate(pool), migrate(pool)]);
  const result = await pool.query('SELECT version FROM schema_migrations');
  expect(result.rows).toHaveLength(1);
  const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  expect(tables.rows.map(row => row.table_name)).toContain('deliveries');
});

it('rolls back failed migrations and rejects checksum drift', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(`${tmpdir()}/relay-migrations-`);
  try {
    await writeFile(`${directory}/999_failure.sql`, 'CREATE TABLE rollback_probe(id int); SELECT missing_function();');
    await expect(migrate(pool, directory)).rejects.toThrow();
    expect((await pool.query("SELECT to_regclass('rollback_probe') AS name")).rows[0].name).toBeNull();
    await writeFile(`${directory}/001_initial.sql`, 'SELECT 1;');
    await expect(migrate(pool, directory)).rejects.toThrow('checksum mismatch');
  } finally { await rm(directory, { recursive: true }); }
});
