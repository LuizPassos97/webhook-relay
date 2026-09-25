import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptSecret } from '../../packages/core/src/secrets.js';
import { createEndpoint } from '../../packages/db/src/endpoints.js';
import type { EventInput } from '../../packages/core/src/events.js';
import { publishEvent, type PublishedEvent } from '../../packages/db/src/events.js';
import { createProjectKey } from '../../packages/db/src/keys.js';
import { migrate } from '../../packages/db/src/migrate.js';
import { createPool, withTransaction } from '../../packages/db/src/pool.js';
import { createProject } from '../../packages/db/src/projects.js';

const masterKey = Buffer.alloc(32, 3);
const input: EventInput = { type: 'order.created', data: { orderId: 42, total: 1999 } };

let pool: Pool;

beforeAll(async () => {
  pool = createPool(
    process.env.TEST_DATABASE_URL ?? 'postgres://relay:relay_local@localhost:55432/relay',
  );
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

/** Creates an isolated project with two endpoints subscribed to `order.created` and one that is not. */
async function setupProject(): Promise<string> {
  return withTransaction(pool, async (client) => {
    const project = await createProject(client, 'Ingestion test');
    const endpoint = { url: 'https://example.com/hook', eventTypes: ['order.created'] };
    await createEndpoint(client, project.id, endpoint, masterKey);
    await createEndpoint(client, project.id, endpoint, masterKey);
    await createEndpoint(
      client,
      project.id,
      { url: 'https://example.com/other', eventTypes: ['order.cancelled'] },
      masterKey,
    );
    return project.id;
  });
}

function publish(
  projectId: string,
  key: string,
  event: EventInput = input,
): Promise<PublishedEvent> {
  return withTransaction(pool, (client) => publishEvent(client, projectId, key, event));
}

async function countRows(table: 'events' | 'deliveries', projectId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table} WHERE project_id = $1`,
    [projectId],
  );
  return result.rows[0]?.count ?? 0;
}

describe('projects, keys and endpoints', () => {
  it('stores only the key hash and an encrypted endpoint secret', async () => {
    const { key, endpoint } = await withTransaction(pool, async (client) => {
      const project = await createProject(client, 'Secrets test');
      return {
        key: await createProjectKey(client, project.id, 'publish'),
        endpoint: await createEndpoint(
          client,
          project.id,
          { url: 'https://example.com/hook', eventTypes: ['order.created'] },
          masterKey,
        ),
      };
    });

    const storedKey = await pool.query<{ hash: string }>(
      'SELECT hash FROM api_keys WHERE id = $1',
      [key.id],
    );
    expect(storedKey.rows[0]?.hash).not.toBe(key.token);
    expect(key.token).toMatch(/^wr_/);

    const storedEndpoint = await pool.query<{ secret: string }>(
      'SELECT secret FROM endpoints WHERE id = $1',
      [endpoint.id],
    );
    const encrypted = storedEndpoint.rows[0]?.secret ?? '';
    expect(encrypted).not.toContain(endpoint.secret);
    expect(decryptSecret(encrypted, masterKey)).toBe(endpoint.secret);
  });
});

describe('publishEvent', () => {
  it('creates one delivery per subscribed endpoint and persists the exact envelope', async () => {
    const projectId = await setupProject();
    const published = await publish(projectId, 'order-42');

    expect(published.created).toBe(true);
    expect(published.deliveryIds).toHaveLength(2);

    const stored = await pool.query<{ body: string }>('SELECT body FROM events WHERE id = $1', [
      published.eventId,
    ]);
    const envelope = JSON.parse(stored.rows[0]?.body ?? '{}') as Record<string, unknown>;
    expect(envelope).toMatchObject({ id: published.eventId, type: input.type, data: input.data });
  });

  it('returns the original event for concurrent requests with the same key and content', async () => {
    const projectId = await setupProject();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => publish(projectId, 'same-key')),
    );

    expect(new Set(results.map((result) => result.eventId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await countRows('events', projectId)).toBe(1);
    expect(await countRows('deliveries', projectId)).toBe(2);
    for (const result of results) {
      expect(result.deliveryIds).toEqual(results[0]?.deliveryIds);
    }
  });

  it('treats reordered JSON keys as the same content', async () => {
    const projectId = await setupProject();
    const first = await publish(projectId, 'reordered');
    const repeat = await publish(projectId, 'reordered', {
      type: 'order.created',
      data: { total: 1999, orderId: 42 },
    });

    expect(repeat).toMatchObject({ eventId: first.eventId, created: false });
  });

  it('rejects a reused key with different content without partial fan-out', async () => {
    const projectId = await setupProject();
    const changed = { type: 'order.created', data: { orderId: 42, total: 1 } };

    const outcomes = await Promise.allSettled([
      publish(projectId, 'conflict'),
      publish(projectId, 'conflict', changed),
    ]);

    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 409 });
    expect(await countRows('events', projectId)).toBe(1);
    expect(await countRows('deliveries', projectId)).toBe(2);
  });

  it('keeps the original destination snapshot on repeated requests', async () => {
    const projectId = await setupProject();
    const first = await publish(projectId, 'snapshot');

    await withTransaction(pool, (client) =>
      createEndpoint(
        client,
        projectId,
        { url: 'https://example.com/late', eventTypes: ['order.created'] },
        masterKey,
      ),
    );
    const repeat = await publish(projectId, 'snapshot');

    expect(repeat.deliveryIds).toEqual(first.deliveryIds);
    expect(await countRows('deliveries', projectId)).toBe(2);
  });

  it('rolls back the event and its deliveries when the transaction fails', async () => {
    const projectId = await setupProject();

    await expect(
      withTransaction(pool, async (client) => {
        await publishEvent(client, projectId, 'rollback', input);
        throw new Error('simulated failure after fan-out');
      }),
    ).rejects.toThrow('simulated failure');

    expect(await countRows('events', projectId)).toBe(0);
    expect(await countRows('deliveries', projectId)).toBe(0);
  });

  it('scopes idempotency keys to a project', async () => {
    const first = await publish(await setupProject(), 'shared-key');
    const second = await publish(await setupProject(), 'shared-key');

    expect(second.eventId).not.toBe(first.eventId);
    expect(second.created).toBe(true);
  });

  it('accepts an event with no subscribed endpoint', async () => {
    const projectId = await setupProject();
    const published = await publish(projectId, 'unsubscribed', { type: 'user.deleted', data: {} });

    expect(published.deliveryIds).toEqual([]);
  });
});
