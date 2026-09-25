import { createPool } from '../packages/db/src/pool.js';
import { migrate } from '../packages/db/src/migrate.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const pool = createPool(databaseUrl);
try {
  await migrate(pool);
} finally {
  await pool.end();
}
