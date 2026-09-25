import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESPONSE_EXCERPT_BYTES, sendWebhook } from '../apps/worker/src/http-transport.js';
import { verify } from '../packages/core/src/signatures.js';

const SECRET = 'test-secret';

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }

  switch (request.url) {
    case '/slow':
      return; // never respond, so the client deadline must fire
    case '/redirect':
      response.writeHead(302, { location: '/signed' });
      response.end();
      return;
    case '/large':
      response.end('x'.repeat(10_000));
      return;
  }

  const isValid = verify(
    Buffer.concat(chunks),
    Number(request.headers['x-webhook-timestamp']),
    String(request.headers['x-webhook-signature']),
    SECRET,
    Math.floor(Date.now() / 1000),
  );
  response.writeHead(isValid ? 200 : 401);
  response.end('accepted');
}

const server = createServer((request, response) => {
  void handleRequest(request, response);
});
let origin: string;

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

function send(path: string, timeoutMs = 500) {
  return sendWebhook({
    url: origin + path,
    demoOrigin: origin,
    body: '{"id":"event"}',
    secret: SECRET,
    eventId: 'event',
    deliveryId: 'delivery',
    timeoutMs,
  });
}

describe('sendWebhook', () => {
  it('delivers the exact signed body', async () => {
    expect(await send('/signed')).toMatchObject({
      kind: 'response',
      status: 200,
      excerpt: 'accepted',
    });
  });

  it('does not follow redirects', async () => {
    expect(await send('/redirect')).toMatchObject({ status: 302 });
  });

  it('bounds the captured response body', async () => {
    const outcome = await send('/large');
    expect(outcome.excerpt).toHaveLength(RESPONSE_EXCERPT_BYTES);
  });

  it('enforces a total deadline', async () => {
    expect(await send('/slow', 50)).toMatchObject({ kind: 'timeout' });
  });

  it('connects to the validated IP without a second DNS lookup', async () => {
    // A resolver that returns a different address on the second call simulates DNS rebinding.
    const fakeOrigin = origin.replace('127.0.0.1', 'receiver.test');
    let lookups = 0;

    const outcome = await sendWebhook({
      url: `${fakeOrigin}/signed`,
      demoOrigin: fakeOrigin,
      body: '{}',
      secret: SECRET,
      eventId: 'event',
      deliveryId: 'delivery',
      timeoutMs: 500,
      resolver: () => {
        lookups += 1;
        const address = lookups === 1 ? '127.0.0.1' : '192.0.2.10';
        return Promise.resolve([{ address, family: 4 }]);
      },
    });

    expect(outcome.status).toBe(200);
    expect(lookups).toBe(1);
  });
});

describe('destination failures', () => {
  const base = {
    body: '{}',
    secret: SECRET,
    eventId: 'event',
    deliveryId: 'delivery',
    timeoutMs: 500,
  };

  it('reports a policy violation as rejected', async () => {
    const outcome = await sendWebhook({ ...base, url: 'https://10.0.0.1/hook' });
    expect(outcome.kind).toBe('rejected');
  });

  it('reports a DNS failure as a retryable network error', async () => {
    const outcome = await sendWebhook({
      ...base,
      url: 'https://missing.example/hook',
      resolver: () => Promise.reject(new Error('ENOTFOUND')),
    });
    expect(outcome.kind).toBe('network');
  });
});
