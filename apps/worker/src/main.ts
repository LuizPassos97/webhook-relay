import { readConfig } from '../../../packages/core/src/config.js';
import { createJsonLogger, errorMessage } from '../../../packages/core/src/logger.js';
import { createPool } from '../../../packages/db/src/pool.js';
import { startWorker } from './runner.js';

const config = readConfig(process.env);
const pool = createPool(config.databaseUrl);
const logger = createJsonLogger();

const worker = startWorker({ pool, config, logger });
logger.info('Worker started', { concurrency: config.concurrency });

async function shutdown(signal: string): Promise<void> {
  logger.info('Worker stopping', { signal });
  await worker.stop();
  await pool.end();
  logger.info('Worker stopped');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      logger.error('Worker shutdown failed', { error: errorMessage(error) });
      process.exitCode = 1;
    });
  });
}
