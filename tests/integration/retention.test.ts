import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { claimDeliveries } from '../../packages/db/src/deliveries.js';
import { createEndpoint } from '../../packages/db/src/endpoints.js';
import { publishEvent } from '../../packages/db/src/events.js';
import { withTransaction } from '../../packages/db/src/pool.js';
import { createProject } from '../../packages/db/src/projects.js';
import { cleanupExpired } from '../../packages/db/src/retention.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

let database: TestDatabase;
let pool: Pool;
let projectId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = database.pool;
  projectId = await withTransaction(pool, async (client) => {
    const project = await createProject(client, 'Retention test');
    await createEndpoint(
      client,
      project.id,
      { url: 'https://example.com/hook', eventTypes: ['order.created'] },
      Buffer.alloc(32, 1),
    );
    return project.id;
  });
});

afterEach(async () => {
  await pool.query('TRUNCATE events CASCADE');
});

afterAll(async () => {
  await database.drop();
});

/** Publishes an event whose single delivery is in `state`, created `ageDays` ago. */
async function eventWith(state: string, ageDays: number): Promise<string> {
  const { eventId } = await withTransaction(pool, (client) =>
    publishEvent(client, projectId, crypto.randomUUID(), { type: 'order.created', data: {} }),
  );
  await pool.query(
    `UPDATE events SET created_at = now() - make_interval(days => $2) WHERE id = $1`,
    [eventId, ageDays],
  );
  if (state === 'processing') {
    await claimDeliveries(pool, 1, 60_000);
  } else if (state !== 'pending') {
    await pool.query('UPDATE deliveries SET state = $2, completed_at = now() WHERE event_id = $1', [
      eventId,
      state,
    ]);
  }
  return eventId;
}

async function exists(eventId: string): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM events WHERE id = $1', [eventId]);
  return result.rowCount === 1;
}

describe('cleanupExpired', () => {
  it('removes expired events whose deliveries are all finished', async () => {
    const succeeded = await eventWith('succeeded', 40);
    const failed = await eventWith('failed', 40);

    expect(await cleanupExpired(pool, 30, 100)).toBe(2);

    expect(await exists(succeeded)).toBe(false);
    expect(await exists(failed)).toBe(false);
    const orphans = await pool.query('SELECT 1 FROM deliveries');
    expect(orphans.rowCount).toBe(0);
  });

  it('keeps expired events that still have pending or in-flight deliveries', async () => {
    const pending = await eventWith('pending', 40);
    const processing = await eventWith('processing', 40);

    expect(await cleanupExpired(pool, 30, 100)).toBe(0);

    expect(await exists(pending)).toBe(true);
    expect(await exists(processing)).toBe(true);
  });

  it('keeps finished events that are still inside the retention window', async () => {
    const recent = await eventWith('succeeded', 10);

    expect(await cleanupExpired(pool, 30, 100)).toBe(0);
    expect(await exists(recent)).toBe(true);
  });

  it('deletes in bounded batches until nothing expired is left', async () => {
    const expired = await Promise.all(Array.from({ length: 5 }, () => eventWith('failed', 40)));

    expect(await cleanupExpired(pool, 30, 2)).toBe(5);

    for (const eventId of expired) expect(await exists(eventId)).toBe(false);
  });
});
