import { Pool, type PoolClient } from 'pg';
export function createPool(url: string): Pool {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000, statement_timeout: 10000 });
  pool.on('error', () => { process.stderr.write('Idle database connection failed\n'); });
  return pool;
}
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
