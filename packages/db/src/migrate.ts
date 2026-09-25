import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from './pool.js';

const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));

// Arbitrary constant shared by every process that runs migrations.
const MIGRATION_LOCK_ID = 71942301;

/**
 * Applies pending SQL migrations in file-name order.
 *
 * All migrations run in a single transaction guarded by an advisory lock, so concurrent
 * startups apply each file exactly once and a failure leaves the schema untouched.
 * Previously applied files are checksummed; editing one after release is rejected.
 */
export async function migrate(pool: Pool, directory = DEFAULT_MIGRATIONS_DIRECTORY): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of files) {
      const sql = await readFile(join(directory, name), 'utf8');
      await applyMigration(client, name, sql);
    }
  });
}

async function applyMigration(client: PoolClient, version: string, sql: string): Promise<void> {
  const checksum = createHash('sha256').update(sql).digest('hex');
  const existing = await client.query<{ checksum: string }>(
    'SELECT checksum FROM schema_migrations WHERE version = $1',
    [version],
  );

  const applied = existing.rows[0];
  if (applied) {
    if (applied.checksum !== checksum) {
      throw new Error(`Migration checksum mismatch: ${version}`);
    }
    return;
  }

  await client.query(sql);
  await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
    version,
    checksum,
  ]);
}
