import { metrics } from '@opentelemetry/api';
import { readConfig } from '../../../packages/core/src/config.js';
import { createJsonLogger, errorMessage } from '../../../packages/core/src/logger.js';
import { observeQueueAge, startTelemetry } from '../../../packages/core/src/telemetry.js';
import { oldestDueAgeSeconds } from '../../../packages/db/src/deliveries.js';
import { createPool } from '../../../packages/db/src/pool.js';
import { cleanupExpired } from '../../../packages/db/src/retention.js';
import { startHealthServer } from './health.js';
import { startWorker } from './runner.js';

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 500;

const config = readConfig(process.env);
const logger = createJsonLogger();

// Telemetry must start before any metric instrument is created.
const stopTelemetry = await startTelemetry({
  serviceName: 'webhook-relay-worker',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});

const pool = createPool(config.databaseUrl);
observeQueueAge(metrics.getMeter('webhook-relay'), () => oldestDueAgeSeconds(pool));

const worker = startWorker({ pool, config, logger });
const health = await startHealthServer({
  port: config.workerPort,
  pool,
  isAcceptingWork: () => worker.isAcceptingWork(),
});
logger.info('Worker started', { concurrency: config.concurrency, healthPort: config.workerPort });

// Every worker runs cleanup; SKIP LOCKED lets several instances share the work safely.
async function runRetention(): Promise<void> {
  try {
    const deleted = await cleanupExpired(pool, config.retentionDays, RETENTION_BATCH_SIZE);
    if (deleted > 0) logger.info('Expired events deleted', { deleted });
  } catch (error) {
    logger.error('Retention cleanup failed', { error: errorMessage(error) });
  }
}
void runRetention();
const retentionTimer = setInterval(() => void runRetention(), RETENTION_INTERVAL_MS);

async function shutdown(signal: string): Promise<void> {
  logger.info('Worker stopping', { signal });
  clearInterval(retentionTimer);
  await worker.stop();
  await health.close();
  await pool.end();
  await stopTelemetry();
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
