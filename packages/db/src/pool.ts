import { Pool, type PoolClient } from 'pg';

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
  });

  // Without a listener, an idle client error would crash the process.
  // The message is intentionally generic so connection details are never logged.
  pool.on('error', () => {
    process.stderr.write('Idle database connection failed\n');
  });

  return pool;
}

/** Runs `work` inside a transaction, committing on success and rolling back on any error. */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Readiness probe: true when the database answers a trivial query within `timeoutMs`.
 * Errors are swallowed on purpose; callers only report ready or not ready.
 */
export async function isDatabaseReady(pool: Pool, timeoutMs = 1000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  const query = pool.query('SELECT 1').then(
    () => true,
    () => false,
  );

  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
