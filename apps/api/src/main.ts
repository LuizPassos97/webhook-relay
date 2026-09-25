import { readConfig } from '../../../packages/core/src/config.js';
import { createPool } from '../../../packages/db/src/pool.js';
import { buildApp } from './app.js';

const config = readConfig(process.env);
const pool = createPool(config.databaseUrl);

const app = await buildApp({
  pool,
  config,
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Request logs never include bodies; headers are redacted in case a serializer adds them.
    redact: ['req.headers.authorization', 'req.headers["idempotency-key"]'],
  },
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down');
  await app.close(); // stops accepting connections and waits for in-flight requests
  await pool.end();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error }, 'Shutdown failed');
      process.exitCode = 1;
    });
  });
}

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: config.port });
