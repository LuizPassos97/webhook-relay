import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createEndpoint } from '../../packages/db/src/endpoints.js';
import { publishEvent } from '../../packages/db/src/events.js';
import { withTransaction } from '../../packages/db/src/pool.js';
import { createProject } from '../../packages/db/src/projects.js';
import { createTestDatabase, waitFor, type TestDatabase } from '../helpers/database.js';
import { respondWith, startReceiver, type TestReceiver } from '../helpers/receiver.js';

const MASTER_KEY_HEX = '11'.repeat(32);

let database: TestDatabase;
let receiver: TestReceiver;

beforeAll(async () => {
  database = await createTestDatabase();
  receiver = await startReceiver(respondWith(200));
});

afterAll(async () => {
  await receiver.close();
  await database.drop();
});

/** Starts the real worker entry point as a separate operating system process. */
function startWorkerProcess(): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL: database.url,
      MASTER_KEY: MASTER_KEY_HEX,
      DEMO_ORIGIN: receiver.origin,
      DELIVERY_TIMEOUT_MS: '1000',
      LEASE_MS: '2000',
      WORKER_POLL_MS: '50',
    },
  });
}

it('redelivers after a worker is killed mid-delivery without losing the event', async () => {
  const { eventId, deliveryIds } = await withTransaction(database.pool, async (client) => {
    const project = await createProject(client, 'Recovery test');
    await createEndpoint(
      client,
      project.id,
      { url: `${receiver.origin}/hook`, eventTypes: ['order.created'] },
      Buffer.from(MASTER_KEY_HEX, 'hex'),
    );
    return publishEvent(client, project.id, 'crash', {
      type: 'order.created',
      data: { orderId: 99 },
    });
  });
  const deliveryId = deliveryIds[0] ?? '';

  // The first worker crashes as soon as the receiver has the request, so the receiver
  // processed the event but the worker never recorded the outcome.
  const doomed = startWorkerProcess();
  const doomedExit = once(doomed, 'exit');
  receiver.setHandler(async (request, response) => {
    doomed.kill('SIGKILL');
    await doomedExit;
    await respondWith(200)(request, response);
  });
  await waitFor(() => receiver.requests.length === 1);
  const [, signal] = (await doomedExit) as [number | null, string | null];
  expect(signal).toBe('SIGKILL');

  // A healthy worker takes over once the dead worker's lease expires.
  receiver.setHandler(respondWith(200));
  const survivor = startWorkerProcess();
  try {
    await waitFor(
      async () => {
        const result = await database.pool.query(
          "SELECT 1 FROM deliveries WHERE id = $1 AND state = 'succeeded'",
          [deliveryId],
        );
        return result.rowCount === 1;
      },
      { timeoutMs: 15_000 },
    );
  } finally {
    survivor.kill('SIGTERM');
    const [code] = (await once(survivor, 'exit')) as [number | null];
    expect(code).toBe(0);
  }

  // At-least-once: the receiver saw the same event twice, with identical bytes and IDs.
  expect(receiver.requests).toHaveLength(2);
  const [first, second] = receiver.requests;
  expect(second?.headers['x-webhook-id']).toBe(eventId);
  expect(second?.headers['x-webhook-delivery-id']).toBe(first?.headers['x-webhook-delivery-id']);
  expect(second?.body.equals(first?.body ?? Buffer.alloc(0))).toBe(true);

  const attempts = await database.pool.query<{ number: number; outcome: string }>(
    'SELECT number, outcome FROM delivery_attempts WHERE delivery_id = $1 ORDER BY number',
    [deliveryId],
  );
  expect(attempts.rows).toEqual([
    { number: 1, outcome: 'abandoned' },
    { number: 2, outcome: 'response' },
  ]);

  const events = await database.pool.query('SELECT 1 FROM events WHERE id = $1', [eventId]);
  expect(events.rowCount).toBe(1);
});
