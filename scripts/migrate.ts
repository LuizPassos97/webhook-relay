import { readDatabaseUrl } from '../packages/core/src/config.js';
import { createPool } from '../packages/db/src/pool.js';
import { migrate } from '../packages/db/src/migrate.js';

const pool = createPool(readDatabaseUrl(process.env));
try {
  await migrate(pool);
} finally {
  await pool.end();
}
