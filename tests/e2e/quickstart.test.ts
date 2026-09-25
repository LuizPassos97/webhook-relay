import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { startWorker, type WorkerHandle } from '../../apps/worker/src/runner.js';
import type { Config } from '../../packages/core/src/config.js';
import { silentLogger } from '../../packages/core/src/logger.js';
import { bootstrapOperatorKey } from '../../packages/db/src/keys.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { respondWith, startReceiver, type TestReceiver } from '../helpers/receiver.js';

// Runs the README quickstart exactly as documented, so the docs cannot drift from the API.

const run = promisify(execFile);

let database: TestDatabase;
let receiver: TestReceiver;
let api: FastifyInstance;
let worker: WorkerHandle;
let operatorKey: string;

beforeAll(async () => {
  database = await createTestDatabase();
  receiver = await startReceiver(respondWith(200));
  const config: Config = {
    databaseUrl: database.url,
    masterKey: Buffer.alloc(32, 2),
    production: false,
    demoOrigin: receiver.origin,
    port: 0,
    workerPort: 0,
    concurrency: 2,
    timeoutMs: 1000,
    leaseMs: 5000,
    maxAttempts: 5,
    retentionDays: 30,
    rateLimit: 120,
    retryScale: 1,
    pollIntervalMs: 50,
  };
  api = await buildApp({ pool: database.pool, config });
  await api.listen({ port: 0, host: '127.0.0.1' });
  worker = startWorker({ pool: database.pool, config, logger: silentLogger });
  const operator = await bootstrapOperatorKey(database.pool);
  if (!operator) throw new Error('Expected a fresh installation');
  operatorKey = operator.token;
});

afterAll(async () => {
  await worker.stop();
  await api.close();
  await receiver.close();
  await database.drop();
});

async function readmeQuickstart(): Promise<string> {
  const readme = await readFile('README.md', 'utf8');
  const match = /<!-- quickstart:start -->\s*```bash\n([\s\S]*?)```\s*<!-- quickstart:end -->/.exec(
    readme,
  );
  if (!match?.[1]) throw new Error('README quickstart block not found');
  return match[1];
}

it('publishes and delivers an event by following the README quickstart', async () => {
  const script = await readmeQuickstart();

  const { stdout } = await run('bash', ['-euo', 'pipefail', '-c', script], {
    env: {
      PATH: process.env.PATH,
      API_URL: `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`,
      OPERATOR_KEY: operatorKey,
      WEBHOOK_URL: `${receiver.origin}/quickstart`,
    },
    timeout: 30_000,
  });

  // The final command prints the delivery with its attempt history.
  const delivery = JSON.parse(stdout.trim().split('\n\n').at(-1) ?? '{}') as {
    state?: string;
    attempts?: { number: number; statusCode: number }[];
  };
  expect(delivery.state).toBe('succeeded');
  expect(delivery.attempts).toEqual([{ number: 1, statusCode: 200 }]);

  expect(receiver.requests).toHaveLength(1);
  expect(receiver.requests[0]?.path).toBe('/quickstart');
});
