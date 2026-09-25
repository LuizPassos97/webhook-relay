import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { startHealthServer } from '../../apps/worker/src/health.js';
import type { Config } from '../../packages/core/src/config.js';
import { createPool } from '../../packages/db/src/pool.js';
import { BASE_TEST_DATABASE_URL } from '../helpers/database.js';

const config = { masterKey: Buffer.alloc(32), rateLimit: 100 } as Config;

// Nothing listens on port 1, so every query fails immediately like during an outage.
const healthyPool = createPool(BASE_TEST_DATABASE_URL);
const unavailablePool = createPool('postgres://relay:relay@127.0.0.1:1/relay');

afterAll(async () => {
  await healthyPool.end();
  await unavailablePool.end();
});

describe('API health', () => {
  it('is live and ready when the database answers', async () => {
    const app = await buildApp({ pool: healthyPool, config });
    try {
      expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
      expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('stays live but reports not ready during a database outage', async () => {
    const app = await buildApp({ pool: unavailablePool, config });
    try {
      expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
      const ready = await app.inject({ url: '/health/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.body).not.toContain('127.0.0.1');
    } finally {
      await app.close();
    }
  });
});

describe('worker health server', () => {
  let accepting = true;
  let healthyUrl: string;
  let outageUrl: string;
  const servers: { close(): Promise<void> }[] = [];

  beforeAll(async () => {
    const healthy = await startHealthServer({
      port: 0,
      host: '127.0.0.1',
      pool: healthyPool,
      isAcceptingWork: () => accepting,
    });
    const outage = await startHealthServer({
      port: 0,
      host: '127.0.0.1',
      pool: unavailablePool,
      isAcceptingWork: () => true,
    });
    servers.push(healthy, outage);
    healthyUrl = `http://127.0.0.1:${(healthy.address() as AddressInfo).port}`;
    outageUrl = `http://127.0.0.1:${(outage.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  it('reports ready while running and connected', async () => {
    expect((await fetch(`${healthyUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${healthyUrl}/health/ready`)).status).toBe(200);
  });

  it('reports not ready during a database outage', async () => {
    expect((await fetch(`${outageUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${outageUrl}/health/ready`)).status).toBe(503);
  });

  it('reports not ready once shutdown has started', async () => {
    accepting = false;
    expect((await fetch(`${healthyUrl}/health/ready`)).status).toBe(503);
    accepting = true;
  });

  it('answers 404 for other paths', async () => {
    expect((await fetch(`${healthyUrl}/metrics`)).status).toBe(404);
  });
});
