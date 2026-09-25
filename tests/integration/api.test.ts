import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import type { Config } from '../../packages/core/src/config.js';
import { bootstrapOperatorKey, createOperatorKey } from '../../packages/db/src/keys.js';
import { migrate } from '../../packages/db/src/migrate.js';
import { createPool, withTransaction } from '../../packages/db/src/pool.js';

const config: Config = {
  databaseUrl: 'unused',
  masterKey: Buffer.alloc(32, 9),
  production: false,
  port: 0,
  workerPort: 0,
  concurrency: 1,
  timeoutMs: 5000,
  leaseMs: 30000,
  maxAttempts: 5,
  retentionDays: 30,
  rateLimit: 10000,
  retryScale: 1,
  pollIntervalMs: 1000,
};

const validEvent = { type: 'order.created', data: { orderId: 7 } };

let pool: Pool;
let app: FastifyInstance;
let operatorHeaders: Record<string, string>;

beforeAll(async () => {
  pool = createPool(
    process.env.TEST_DATABASE_URL ?? 'postgres://relay:relay_local@localhost:55432/relay',
  );
  await migrate(pool);
  const operator = await withTransaction(pool, (client) => createOperatorKey(client));
  operatorHeaders = bearer(operator.token);
  app = await buildApp({ pool, config });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface TestProject {
  id: string;
  publishHeaders: Record<string, string>;
  manageHeaders: Record<string, string>;
}

/** Creates a project with publish and manage keys through the public API. */
async function createTestProject(target = app): Promise<TestProject> {
  const project = await target.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: operatorHeaders,
    payload: { name: 'API test' },
  });
  expect(project.statusCode).toBe(201);
  const { id } = project.json<{ id: string }>();

  const issue = async (permission: string) => {
    const response = await target.inject({
      method: 'POST',
      url: `/v1/projects/${id}/keys`,
      headers: operatorHeaders,
      payload: { permission },
    });
    expect(response.statusCode).toBe(201);
    return bearer(response.json<{ token: string }>().token);
  };

  return { id, publishHeaders: await issue('publish'), manageHeaders: await issue('manage') };
}

async function createTestEndpoint(project: TestProject): Promise<{ id: string; secret: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/endpoints',
    headers: project.manageHeaders,
    payload: { url: 'https://example.com/hook', eventTypes: ['order.created'] },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function publish(project: TestProject, key: string, payload: object = validEvent) {
  return app.inject({
    method: 'POST',
    url: '/v1/events',
    headers: { ...project.publishHeaders, 'idempotency-key': key },
    payload,
  });
}

describe('authentication and authorization', () => {
  it('rejects missing, malformed and unknown credentials', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/endpoints' });
    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/endpoints',
      headers: { authorization: 'Basic abc' },
    });
    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/endpoints',
      headers: bearer('wr_unknown'),
    });

    expect([missing.statusCode, malformed.statusCode, unknown.statusCode]).toEqual([401, 401, 401]);
  });

  it('enforces the permission required by each route', async () => {
    const project = await createTestProject();

    const publishOnManageRoute = await app.inject({
      method: 'GET',
      url: '/v1/endpoints',
      headers: project.publishHeaders,
    });
    const manageOnPublishRoute = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { ...project.manageHeaders, 'idempotency-key': 'k' },
      payload: validEvent,
    });
    const projectKeyOnOperatorRoute = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: project.manageHeaders,
      payload: { name: 'nope' },
    });
    const operatorOnProjectRoute = await app.inject({
      method: 'GET',
      url: '/v1/endpoints',
      headers: operatorHeaders,
    });

    expect(publishOnManageRoute.statusCode).toBe(403);
    expect(manageOnPublishRoute.statusCode).toBe(403);
    expect(projectKeyOnOperatorRoute.statusCode).toBe(403);
    expect(operatorOnProjectRoute.statusCode).toBe(403);
  });

  it('rejects revoked keys', async () => {
    const project = await createTestProject();
    await pool.query('UPDATE api_keys SET revoked_at = now() WHERE project_id = $1', [project.id]);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/endpoints',
      headers: project.manageHeaders,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('operator routes', () => {
  it('returns 404 when issuing a key for a missing project', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects/00000000-0000-4000-8000-000000000000/keys',
      headers: operatorHeaders,
      payload: { permission: 'publish' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects an invalid permission and unsupported fields', async () => {
    const project = await createTestProject();
    const badPermission = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/keys`,
      headers: operatorHeaders,
      payload: { permission: 'operator' },
    });
    const extraField = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: operatorHeaders,
      payload: { name: 'x', owner: 'someone' },
    });

    expect(badPermission.statusCode).toBe(400);
    expect(extraField.statusCode).toBe(400);
  });
});

describe('endpoints', () => {
  it('reveals the signing secret only on creation', async () => {
    const project = await createTestProject();
    const created = await createTestEndpoint(project);
    expect(created.secret).toMatch(/^whsec_/);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/endpoints',
      headers: project.manageHeaders,
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(created.secret);
    expect(list.json()).toMatchObject({ items: [{ id: created.id }], nextCursor: null });
  });

  it.each(['http://example.com/hook', 'https://10.0.0.1/hook', 'https://localhost/hook'])(
    'rejects unsafe destination %s',
    async (url) => {
      const project = await createTestProject();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/endpoints',
        headers: project.manageHeaders,
        payload: { url, eventTypes: ['order.created'] },
      });
      expect(response.statusCode).toBe(400);
    },
  );

  it('paginates with a bounded limit', async () => {
    const project = await createTestProject();
    for (let index = 0; index < 3; index += 1) await createTestEndpoint(project);

    const firstPage = await app.inject({
      method: 'GET',
      url: '/v1/endpoints?limit=2',
      headers: project.manageHeaders,
    });
    const { items, nextCursor } = firstPage.json<{ items: unknown[]; nextCursor: string }>();
    expect(items).toHaveLength(2);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/v1/endpoints?limit=2&cursor=${nextCursor}`,
      headers: project.manageHeaders,
    });
    expect(secondPage.json()).toMatchObject({ items: [{}], nextCursor: null });

    const tooLarge = await app.inject({
      method: 'GET',
      url: '/v1/endpoints?limit=1000',
      headers: project.manageHeaders,
    });
    expect(tooLarge.statusCode).toBe(400);
  });
});

describe('events', () => {
  it('accepts an event and returns its deliveries', async () => {
    const project = await createTestProject();
    await createTestEndpoint(project);

    const response = await publish(project, 'order-7');

    expect(response.statusCode).toBe(202);
    const body = response.json<{ eventId: string; deliveryIds: string[] }>();
    expect(body.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.deliveryIds).toHaveLength(1);
  });

  it('returns the original event for a repeated key and 409 for changed content', async () => {
    const project = await createTestProject();
    const first = await publish(project, 'repeat');
    const repeat = await publish(project, 'repeat');
    const changed = await publish(project, 'repeat', {
      type: 'order.created',
      data: { orderId: 8 },
    });

    expect(repeat.statusCode).toBe(202);
    expect(repeat.json<{ eventId: string }>().eventId).toBe(
      first.json<{ eventId: string }>().eventId,
    );
    expect(changed.statusCode).toBe(409);
  });

  it('validates the idempotency key, body shape and size before writing', async () => {
    const project = await createTestProject();
    const missingKey = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: project.publishHeaders,
      payload: validEvent,
    });
    const extraField = await publish(project, 'extra', { ...validEvent, projectId: project.id });
    const arrayData = await publish(project, 'array', { type: 'order.created', data: [] });
    const oversized = await publish(project, 'large', {
      type: 'order.created',
      data: { blob: 'x'.repeat(70 * 1024) },
    });

    expect(missingKey.statusCode).toBe(400);
    expect(extraField.statusCode).toBe(400);
    expect(arrayData.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(413);

    const events = await pool.query('SELECT 1 FROM events WHERE project_id = $1', [project.id]);
    expect(events.rowCount).toBe(0);
  });

  it('reads an event with its delivery states', async () => {
    const project = await createTestProject();
    await createTestEndpoint(project);
    const { eventId } = (await publish(project, 'read')).json<{ eventId: string }>();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/events/${eventId}`,
      headers: project.manageHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: eventId,
      type: 'order.created',
      data: validEvent.data,
      deliveries: [{ state: 'pending', attemptCount: 0, cycle: 1 }],
    });
  });

  it('hides events from other projects and rejects malformed IDs', async () => {
    const owner = await createTestProject();
    const other = await createTestProject();
    const { eventId } = (await publish(owner, 'private')).json<{ eventId: string }>();

    const crossProject = await app.inject({
      method: 'GET',
      url: `/v1/events/${eventId}`,
      headers: other.manageHeaders,
    });
    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/events/not-a-uuid',
      headers: owner.manageHeaders,
    });

    expect(crossProject.statusCode).toBe(404);
    expect(crossProject.body).not.toContain(eventId);
    expect(malformed.statusCode).toBe(400);
  });
});

describe('deliveries and replay', () => {
  async function publishWithDelivery(project: TestProject, key: string): Promise<string> {
    await createTestEndpoint(project);
    const { deliveryIds } = (await publish(project, key)).json<{ deliveryIds: string[] }>();
    const [deliveryId] = deliveryIds;
    if (!deliveryId) throw new Error('Expected a delivery');
    return deliveryId;
  }

  it('reads a delivery with its attempt history', async () => {
    const project = await createTestProject();
    const deliveryId = await publishWithDelivery(project, 'delivery-read');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/deliveries/${deliveryId}`,
      headers: project.manageHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: deliveryId, state: 'pending', attempts: [] });
  });

  it('refuses to replay an active delivery', async () => {
    const project = await createTestProject();
    const deliveryId = await publishWithDelivery(project, 'replay-active');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/deliveries/${deliveryId}/replay`,
      headers: project.manageHeaders,
    });
    expect(response.statusCode).toBe(409);
  });

  it('replays a terminal delivery in a new cycle and audits the requesting key', async () => {
    const project = await createTestProject();
    const deliveryId = await publishWithDelivery(project, 'replay-failed');
    await pool.query(
      "UPDATE deliveries SET state = 'failed', attempt_count = 5, completed_at = now() WHERE id = $1",
      [deliveryId],
    );

    const response = await app.inject({
      method: 'POST',
      url: `/v1/deliveries/${deliveryId}/replay`,
      headers: project.manageHeaders,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ deliveryId, cycle: 2 });

    const delivery = await pool.query<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM deliveries WHERE id = $1',
      [deliveryId],
    );
    expect(delivery.rows[0]).toMatchObject({ state: 'pending', attempt_count: 0 });

    const audit = await pool.query<{ permission: string }>(
      `SELECT k.permission FROM replay_audit r JOIN api_keys k ON k.id = r.actor_key_id
       WHERE r.delivery_id = $1 AND r.cycle = 2`,
      [deliveryId],
    );
    expect(audit.rows).toEqual([{ permission: 'manage' }]);
  });

  it('does not reveal or replay deliveries from other projects', async () => {
    const owner = await createTestProject();
    const other = await createTestProject();
    const deliveryId = await publishWithDelivery(owner, 'replay-cross');
    await pool.query("UPDATE deliveries SET state = 'failed' WHERE id = $1", [deliveryId]);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/deliveries/${deliveryId}`,
      headers: other.manageHeaders,
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/deliveries/${deliveryId}/replay`,
      headers: other.manageHeaders,
    });

    expect(read.statusCode).toBe(404);
    expect(replay.statusCode).toBe(404);
    const state = await pool.query('SELECT cycle FROM deliveries WHERE id = $1', [deliveryId]);
    expect(state.rows[0]).toEqual({ cycle: 1 });
  });
});

describe('rate limiting', () => {
  it('shares one per-project allowance across API instances', async () => {
    const limited = { ...config, rateLimit: 4 };
    const first = await buildApp({ pool, config: limited });
    const second = await buildApp({ pool, config: limited });
    try {
      // Project setup uses the operator key, which has its own allowance.
      const project = await createTestProject(first);
      const statuses: number[] = [];
      for (const instance of [first, second, first, second, first]) {
        const response = await instance.inject({
          method: 'GET',
          url: '/v1/endpoints',
          headers: project.manageHeaders,
        });
        statuses.push(response.statusCode);
        if (response.statusCode === 429) {
          expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        }
      }
      expect(statuses).toEqual([200, 200, 200, 200, 429]);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('bootstrap and OpenAPI', () => {
  it('issues the operator key only once per installation', async () => {
    // Other tests already created operator keys, so bootstrapping must refuse.
    expect(await bootstrapOperatorKey(pool)).toBeNull();
  });

  it('serves an OpenAPI document that matches the committed file', async () => {
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);

    const served = response.json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(served.paths)).toEqual(
      expect.arrayContaining(['/v1/events', '/v1/deliveries/{id}/replay']),
    );

    const committed = JSON.parse(await readFile('docs/openapi.json', 'utf8')) as unknown;
    expect(served).toEqual(committed);
  });
});
