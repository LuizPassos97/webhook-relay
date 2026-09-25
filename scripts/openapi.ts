// Regenerates docs/openapi.json from the API route schemas.
// No database connection is made: the pool is created lazily and never queried.
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../apps/api/src/app.js';
import type { Config } from '../packages/core/src/config.js';
import { createPool } from '../packages/db/src/pool.js';

const pool = createPool('postgres://unused@localhost/unused');
const app = await buildApp({ pool, config: {} as Config });

try {
  await writeFile('docs/openapi.json', `${JSON.stringify(app.swagger(), null, 2)}\n`);
} finally {
  await app.close();
  await pool.end();
}
