// Initializes an installation: applies migrations and prints the operator API key once.
// Running it again is safe; it refuses to create a second operator key.
import { bootstrapOperatorKey } from '../packages/db/src/keys.js';
import { migrate } from '../packages/db/src/migrate.js';
import { createPool } from '../packages/db/src/pool.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const pool = createPool(databaseUrl);
try {
  await migrate(pool);
  const key = await bootstrapOperatorKey(pool);

  if (key) {
    process.stdout.write(`Operator API key (shown only once, store it securely):\n${key.token}\n`);
  } else {
    process.stderr.write('Installation already has an operator key; nothing was created.\n');
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
