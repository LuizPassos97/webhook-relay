import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { createDemoReceiver } from '../../apps/demo-receiver/src/receiver.js';
import { startWorker, type WorkerHandle } from '../../apps/worker/src/runner.js';
import type { Config } from '../../packages/core/src/config.js';
import { silentLogger } from '../../packages/core/src/logger.js';
import { bootstrapOperatorKey } from '../../packages/db/src/keys.js';
import { findProblems, runDemo, type DemoResult } from '../../scripts/demo.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

let database: TestDatabase;
let api: FastifyInstance;
let worker: WorkerHandle;
const receiver = createDemoReceiver();
let result: DemoResult;

beforeAll(async () => {
  database = await createTestDatabase();
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  const config: Config = {
    databaseUrl: database.url,
    masterKey: Buffer.alloc(32, 8),
    production: false,
    demoOrigin: receiverUrl,
    port: 0,
    workerPort: 0,
    concurrency: 4,
    timeoutMs: 300,
    leaseMs: 2000,
    maxAttempts: 5,
    retentionDays: 30,
    rateLimit: 1000,
    retryScale: 0.0001,
    pollIntervalMs: 20,
  };

  api = await buildApp({ pool: database.pool, config });
  await api.listen({ port: 0, host: '127.0.0.1' });
  worker = startWorker({ pool: database.pool, config, logger: silentLogger });

  const operator = await bootstrapOperatorKey(database.pool);
  if (!operator) throw new Error('Expected a fresh installation');

  result = await runDemo({
    apiUrl: `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`,
    receiverUrl,
    operatorKey: operator.token,
    timeoutMs: 20_000,
  });
}, 30_000);

afterAll(async () => {
  await worker.stop();
  await api.close();
  receiver.closeAllConnections();
  await new Promise((resolve) => receiver.close(resolve));
  await database.drop();
});

it('delivers to a healthy consumer on the first attempt', () => {
  expect(result.successfulDeliveries).toBe(3);
  expect(result.healthy).toMatchObject({ state: 'succeeded', attempts: [{ statusCode: 200 }] });
});

it('retries a flaky consumer until it accepts the event', () => {
  expect(result.flaky.state).toBe('succeeded');
  expect(result.flaky.attempts.map((attempt) => attempt.statusCode)).toEqual([503, 503, 200]);
});

it('retries after a timeout', () => {
  expect(result.slow.state).toBe('succeeded');
  expect(result.slow.attempts.map((attempt) => attempt.outcome)).toEqual(['timeout', 'response']);
});

it('fails after five attempts and succeeds after a replay', () => {
  expect(result.exhausted.beforeReplay).toMatchObject({ state: 'failed', cycle: 1 });
  expect(result.exhausted.beforeReplay.attempts).toHaveLength(5);
  expect(result.exhausted.afterReplay).toMatchObject({ state: 'succeeded', cycle: 2 });
  expect(result.exhausted.afterReplay.attempts).toHaveLength(6);
});

it('shows that the consumer rejects an altered signature', () => {
  expect(result.tamperedSignatureStatus).toBe(401);
});

it('reports no problems when everything behaves as documented', () => {
  expect(findProblems(result)).toEqual([]);
  expect(findProblems({ ...result, healthy: { ...result.healthy, state: 'failed' } })).toEqual([
    'healthy consumer did not succeed',
  ]);
});
