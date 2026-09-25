import { createPool } from '../packages/db/src/pool.js';
import { migrate } from '../packages/db/src/migrate.js';
const pool = createPool(process.env.DATABASE_URL ?? '');
try { await migrate(pool); } finally { await pool.end(); }
