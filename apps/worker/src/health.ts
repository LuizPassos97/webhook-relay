import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { isDatabaseReady } from '../../../packages/db/src/pool.js';

export interface HealthServerOptions {
  port: number;
  host?: string;
  pool: Pool;
  /** Returns false once shutdown has started, so the instance stops reporting ready. */
  isAcceptingWork: () => boolean;
}

export interface HealthServer {
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}

/**
 * Serves `/health/live` and `/health/ready` for the worker, which has no HTTP API of its own.
 * Liveness only proves the event loop responds; readiness also requires the database and a
 * running delivery loop.
 */
export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const server: Server = createServer((request, response) => {
    const respond = (status: number, body: string) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: body }));
    };

    if (request.method !== 'GET') {
      respond(405, 'method_not_allowed');
    } else if (request.url === '/health/live') {
      respond(200, 'ok');
    } else if (request.url === '/health/ready') {
      void isDatabaseReady(options.pool).then((databaseReady) => {
        const ready = databaseReady && options.isAcceptingWork();
        respond(ready ? 200 : 503, ready ? 'ok' : 'unavailable');
      });
    } else {
      respond(404, 'not_found');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host ?? '0.0.0.0', resolve);
  });

  return {
    address: () => server.address(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
