import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** Decides how the receiver answers; it may be async to simulate slow consumers. */
export type ReceiverHandler = (
  request: ReceivedRequest,
  response: ServerResponse,
) => void | Promise<void>;

export interface TestReceiver {
  origin: string;
  requests: ReceivedRequest[];
  /** Highest number of requests handled at the same time. */
  maxConcurrent(): number;
  setHandler(handler: ReceiverHandler): void;
  close(): Promise<void>;
}

/** A local webhook consumer that records every request it receives. */
export async function startReceiver(initial: ReceiverHandler): Promise<TestReceiver> {
  const requests: ReceivedRequest[] = [];
  let handler = initial;
  let active = 0;
  let peak = 0;

  const server = createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));

      const request = {
        path: incoming.url ?? '/',
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(request);

      active += 1;
      peak = Math.max(peak, active);
      try {
        await handler(request, response);
      } finally {
        active -= 1;
      }
    })();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    maxConcurrent: () => peak,
    setHandler(next) {
      handler = next;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

export function respondWith(status: number, delayMs = 0): ReceiverHandler {
  return async (_request, response) => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    response.writeHead(status);
    response.end();
  };
}
