import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runBatch, startWorker, type WorkerDependencies } from '../../apps/worker/src/runner.js';
import type { Config } from '../../packages/core/src/config.js';
import { silentLogger } from '../../packages/core/src/logger.js';
import { verify } from '../../packages/core/src/signatures.js';
import {
  claimDeliveries,
  finishAttempt,
  recoverExpiredLeases,
  replayDelivery,
} from '../../packages/db/src/deliveries.js';
import { createEndpoint } from '../../packages/db/src/endpoints.js';
import { publishEvent } from '../../packages/db/src/events.js';
import { createProjectKey } from '../../packages/db/src/keys.js';
import { withTransaction } from '../../packages/db/src/pool.js';
import { createProject } from '../../packages/db/src/projects.js';
import { createTestDatabase, waitFor, type TestDatabase } from '../helpers/database.js';
import { respondWith, startReceiver, type TestReceiver } from '../helpers/receiver.js';

const masterKey = Buffer.alloc(32, 5);
const LONG_LEASE_MS = 30_000;

let database: TestDatabase;
let pool: Pool;
let receiver: TestReceiver;
let config: Config;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = database.pool;
  receiver = await startReceiver(respondWith(200));
  config = {
    databaseUrl: database.url,
    masterKey,
    production: false,
    demoOrigin: receiver.origin,
    port: 0,
    workerPort: 0,
    concurrency: 4,
    timeoutMs: 300,
    leaseMs: 2000,
    maxAttempts: 5,
    retentionDays: 30,
    rateLimit: 1000,
    retryScale: 0.0001, // the one-minute first retry becomes 6 ms
    pollIntervalMs: 20,
  };
});

afterEach(async () => {
  // Each test starts from an empty queue and a receiver that accepts everything.
  await pool.query('TRUNCATE projects CASCADE');
  receiver.setHandler(respondWith(200));
  receiver.requests.length = 0;
});

afterAll(async () => {
  await receiver.close();
  await database.drop();
});

function workerDeps(overrides: Partial<Config> = {}): WorkerDependencies {
  return { pool, config: { ...config, ...overrides }, logger: silentLogger, random: () => 0.5 };
}

interface Fixture {
  projectId: string;
  eventId: string;
  deliveryIds: string[];
  secrets: string[];
  keyId: string;
}

/** Publishes one event to `paths.length` endpoints on the test receiver. */
async function publishTo(paths: string[]): Promise<Fixture> {
  return withTransaction(pool, async (client) => {
    const project = await createProject(client, 'Worker test');
    const key = await createProjectKey(client, project.id, 'manage');
    const secrets: string[] = [];
    for (const path of paths) {
      const endpoint = await createEndpoint(
        client,
        project.id,
        { url: receiver.origin + path, eventTypes: ['order.created'] },
        masterKey,
      );
      secrets.push(endpoint.secret);
    }
    const event = await publishEvent(client, project.id, 'key', {
      type: 'order.created',
      data: { orderId: 1 },
    });
    return {
      projectId: project.id,
      eventId: event.eventId,
      deliveryIds: event.deliveryIds,
      secrets,
      keyId: key.id,
    };
  });
}

async function deliveryRow(id: string) {
  const result = await pool.query<{
    state: string;
    attempt_count: number;
    cycle: number;
    lease_token: string | null;
  }>('SELECT state, attempt_count, cycle, lease_token FROM deliveries WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row) throw new Error(`Delivery ${id} not found`);
  return row;
}

async function attemptRows(deliveryId: string) {
  const result = await pool.query<{
    cycle: number;
    number: number;
    outcome: string;
    status_code: number | null;
  }>(
    `SELECT cycle, number, outcome, status_code FROM delivery_attempts
     WHERE delivery_id = $1 ORDER BY cycle, number`,
    [deliveryId],
  );
  return result.rows;
}

async function waitForLeaseExpiry(deliveryId: string): Promise<void> {
  await waitFor(async () => {
    const result = await pool.query(
      'SELECT 1 FROM deliveries WHERE id = $1 AND lease_until <= now()',
      [deliveryId],
    );
    return result.rowCount === 1;
  });
}

describe('claiming', () => {
  it('gives each due delivery to exactly one of several concurrent workers', async () => {
    const fixture = await publishTo(Array.from({ length: 10 }, (_, index) => `/hook/${index}`));

    const [left, right] = await Promise.all([
      claimDeliveries(pool, 10, LONG_LEASE_MS),
      claimDeliveries(pool, 10, LONG_LEASE_MS),
    ]);
    const claimedIds = [...left, ...right].map((claim) => claim.id);

    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.sort()).toEqual([...fixture.deliveryIds].sort());
  });

  it('records the attempt when the delivery is claimed', async () => {
    const fixture = await publishTo(['/hook']);
    const [claim] = await claimDeliveries(pool, 1, LONG_LEASE_MS);

    expect(claim).toMatchObject({ attemptNumber: 1, cycle: 1, eventId: fixture.eventId });
    expect(await attemptRows(fixture.deliveryIds[0] ?? '')).toEqual([
      { cycle: 1, number: 1, outcome: 'started', status_code: null },
    ]);
  });

  it('skips deliveries that are not due yet', async () => {
    await publishTo(['/hook']);
    await pool.query("UPDATE deliveries SET next_attempt_at = now() + interval '1 hour'");

    expect(await claimDeliveries(pool, 10, LONG_LEASE_MS)).toEqual([]);
  });
});

describe('lease ownership', () => {
  it('rejects the result of a stale worker after another worker takes over', async () => {
    const fixture = await publishTo(['/hook']);
    const deliveryId = fixture.deliveryIds[0] ?? '';
    const success = { kind: 'response', status: 200, durationMs: 5 } as const;

    const [stale] = await claimDeliveries(pool, 1, 50);
    if (!stale) throw new Error('Expected a claim');
    await waitForLeaseExpiry(deliveryId);

    expect(await recoverExpiredLeases(pool, config.maxAttempts)).toBe(1);
    const [current] = await claimDeliveries(pool, 1, LONG_LEASE_MS);
    if (!current) throw new Error('Expected a second claim');

    expect(await finishAttempt(pool, stale, success, { state: 'succeeded' })).toBe(false);
    expect(await deliveryRow(deliveryId)).toMatchObject({
      state: 'processing',
      lease_token: current.leaseToken,
    });

    expect(await finishAttempt(pool, current, success, { state: 'succeeded' })).toBe(true);
    expect(await attemptRows(deliveryId)).toEqual([
      { cycle: 1, number: 1, outcome: 'abandoned', status_code: null },
      { cycle: 1, number: 2, outcome: 'response', status_code: 200 },
    ]);
  });

  it('rejects a result that arrives after the lease expired, even before recovery', async () => {
    const fixture = await publishTo(['/hook']);
    const [claim] = await claimDeliveries(pool, 1, 50);
    if (!claim) throw new Error('Expected a claim');
    await waitForLeaseExpiry(claim.id);

    const outcome = { kind: 'response', status: 200, durationMs: 5 } as const;
    expect(await finishAttempt(pool, claim, outcome, { state: 'succeeded' })).toBe(false);
    expect(await deliveryRow(fixture.deliveryIds[0] ?? '')).toMatchObject({ state: 'processing' });
  });

  it('counts interrupted attempts and fails a delivery whose last attempt was abandoned', async () => {
    const fixture = await publishTo(['/hook']);
    const deliveryId = fixture.deliveryIds[0] ?? '';
    await pool.query('UPDATE deliveries SET attempt_count = 4 WHERE id = $1', [deliveryId]);

    await claimDeliveries(pool, 1, 50);
    await waitForLeaseExpiry(deliveryId);
    await recoverExpiredLeases(pool, config.maxAttempts);

    expect(await deliveryRow(deliveryId)).toMatchObject({ state: 'failed', attempt_count: 5 });
  });
});

describe('runBatch', () => {
  it('sends signed requests and applies the retry policy to each outcome', async () => {
    receiver.setHandler(async (request, response) => {
      const status = Number(request.path.split('/').at(-1));
      if (Number.isNaN(status)) return; // "/slow" never answers
      await respondWith(status)(request, response);
    });
    const fixture = await publishTo(['/200', '/400', '/302', '/429', '/503', '/slow']);

    expect(await runBatch(workerDeps({ concurrency: 10 }))).toBe(6);

    const byPath = new Map<string, { state: string; outcome?: string }>();
    for (const deliveryId of fixture.deliveryIds) {
      const path = await pool.query<{ url: string }>(
        'SELECT e.url FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id WHERE d.id = $1',
        [deliveryId],
      );
      const [attempt] = await attemptRows(deliveryId);
      byPath.set(new URL(path.rows[0]?.url ?? '').pathname, {
        state: (await deliveryRow(deliveryId)).state,
        outcome: attempt?.outcome,
      });
    }

    expect(Object.fromEntries(byPath)).toEqual({
      '/200': { state: 'succeeded', outcome: 'response' },
      '/400': { state: 'failed', outcome: 'response' },
      '/302': { state: 'failed', outcome: 'response' },
      '/429': { state: 'pending', outcome: 'response' },
      '/503': { state: 'pending', outcome: 'response' },
      '/slow': { state: 'pending', outcome: 'timeout' },
    });

    // Every request carried a valid signature for its own endpoint secret.
    const signed = receiver.requests.filter((request) =>
      fixture.secrets.some((secret) =>
        verify(
          request.body,
          Number(request.headers['x-webhook-timestamp']),
          String(request.headers['x-webhook-signature']),
          secret,
          Math.floor(Date.now() / 1000),
        ),
      ),
    );
    expect(signed).toHaveLength(6);
  });

  it('fails after five attempts and a replay starts a new cycle with the same IDs', async () => {
    receiver.setHandler(respondWith(500));
    const fixture = await publishTo(['/flaky']);
    const deliveryId = fixture.deliveryIds[0] ?? '';

    await waitFor(async () => {
      await runBatch(workerDeps());
      return (await deliveryRow(deliveryId)).state === 'failed';
    });
    expect(await deliveryRow(deliveryId)).toMatchObject({ attempt_count: 5, cycle: 1 });

    await withTransaction(pool, (client) =>
      replayDelivery(client, fixture.projectId, deliveryId, fixture.keyId),
    );
    receiver.setHandler(respondWith(200));

    await waitFor(async () => {
      await runBatch(workerDeps());
      return (await deliveryRow(deliveryId)).state === 'succeeded';
    });

    const attempts = await attemptRows(deliveryId);
    expect(attempts).toHaveLength(6);
    expect(attempts.at(-1)).toEqual({ cycle: 2, number: 1, outcome: 'response', status_code: 200 });

    const eventIds = new Set(receiver.requests.map((request) => request.headers['x-webhook-id']));
    const deliveryIds = new Set(
      receiver.requests.map((request) => request.headers['x-webhook-delivery-id']),
    );
    expect([...eventIds]).toEqual([fixture.eventId]);
    expect([...deliveryIds]).toEqual([deliveryId]);
  });
});

describe('startWorker', () => {
  it('never runs more requests at once than its concurrency', async () => {
    receiver.setHandler(respondWith(200, 50));
    const fixture = await publishTo(Array.from({ length: 10 }, (_, index) => `/hook/${index}`));

    const worker = startWorker(workerDeps({ concurrency: 3 }));
    try {
      await waitFor(async () => {
        const result = await pool.query(
          "SELECT 1 FROM deliveries WHERE state = 'succeeded' AND event_id = $1",
          [fixture.eventId],
        );
        return result.rowCount === 10;
      });
    } finally {
      await worker.stop();
    }

    expect(receiver.maxConcurrent()).toBeLessThanOrEqual(3);
    expect(receiver.maxConcurrent()).toBeGreaterThan(1);
  });

  it('stops claiming on shutdown and finishes the requests already in flight', async () => {
    receiver.setHandler(respondWith(200, 200));
    await publishTo(Array.from({ length: 6 }, (_, index) => `/hook/${index}`));

    const worker = startWorker(workerDeps({ concurrency: 2 }));
    await waitFor(() => receiver.requests.length >= 1);
    await worker.stop();

    const states = await pool.query<{ state: string; count: number }>(
      'SELECT state, count(*)::int AS count FROM deliveries GROUP BY state ORDER BY state',
    );
    const counts = Object.fromEntries(states.rows.map((row) => [row.state, row.count]));

    expect(counts.processing).toBeUndefined();
    expect(counts.succeeded).toBe(receiver.requests.length);
    expect(counts.pending).toBe(6 - receiver.requests.length);
  });
});
