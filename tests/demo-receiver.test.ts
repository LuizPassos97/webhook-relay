import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDemoReceiver } from '../apps/demo-receiver/src/receiver.js';
import { sign } from '../packages/core/src/signatures.js';

const SECRET = 'whsec_demo';
const receiver = createDemoReceiver();
let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterAll(async () => {
  receiver.closeAllConnections();
  await new Promise((resolve) => receiver.close(resolve));
});

async function configure(name: string, scenario: object): Promise<void> {
  const response = await fetch(`${origin}/_control/scenarios/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, ...scenario }),
  });
  expect(response.status).toBe(204);
}

async function deliver(
  name: string,
  eventId: string,
  { timestamp = Math.floor(Date.now() / 1000), tamper = false, timeoutMs = 2000 } = {},
): Promise<number> {
  const body = Buffer.from(JSON.stringify({ id: eventId, type: 'demo', data: {} }));
  const signature = sign(body, timestamp, SECRET);
  const sent = tamper
    ? Buffer.from(JSON.stringify({ id: eventId, type: 'demo', data: { x: 1 } }))
    : body;
  const response = await fetch(`${origin}/hooks/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-id': eventId,
      'x-webhook-timestamp': String(timestamp),
      'x-webhook-signature': signature,
    },
    body: sent,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response.status;
}

async function state(name: string) {
  const response = await fetch(`${origin}/_control/scenarios/${name}`);
  return response.json() as Promise<Record<string, unknown>>;
}

describe('demo receiver', () => {
  it('accepts signed events and counts duplicate deliveries by event ID', async () => {
    await configure('ok', {});

    expect(await deliver('ok', 'evt-1')).toBe(200);
    expect(await deliver('ok', 'evt-1')).toBe(200);

    expect(await state('ok')).toMatchObject({ requests: 2, accepted: ['evt-1'], duplicates: 1 });
  });

  it('rejects altered bodies and stale timestamps before any other processing', async () => {
    await configure('strict', {});

    expect(await deliver('strict', 'evt-2', { tamper: true })).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 600;
    expect(await deliver('strict', 'evt-3', { timestamp: stale })).toBe(401);

    expect(await state('strict')).toMatchObject({ rejected: 2, accepted: [] });
  });

  it('fails a configured number of times before accepting', async () => {
    await configure('flaky', { failTimes: 2 });

    expect(await deliver('flaky', 'evt-4')).toBe(503);
    expect(await deliver('flaky', 'evt-4')).toBe(503);
    expect(await deliver('flaky', 'evt-4')).toBe(200);
  });

  it('can simulate a consumer that never answers', async () => {
    await configure('slow', { failTimes: 1, failureMode: 'timeout' });

    await expect(deliver('slow', 'evt-5', { timeoutMs: 100 })).rejects.toThrow();
    expect(await deliver('slow', 'evt-5')).toBe(200);
  });

  it('keeps failing when configured to always fail', async () => {
    await configure('broken', { failTimes: 'always' });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await deliver('broken', 'evt-6')).toBe(503);
    }
  });

  it('returns 404 for unknown scenarios and rejects invalid configuration', async () => {
    expect(await deliver('missing', 'evt-7')).toBe(404);
    const invalid = await fetch(`${origin}/_control/scenarios/bad`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ failTimes: 2 }),
    });
    expect(invalid.status).toBe(400);
  });
});
