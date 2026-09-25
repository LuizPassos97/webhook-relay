import type { FastifyInstance } from 'fastify';
import { isDatabaseReady } from '../../../../packages/db/src/pool.js';
import type { ApiDependencies } from '../app.js';

/**
 * Liveness answers without touching dependencies, so an orchestrator does not restart a
 * healthy process during a database outage. Readiness checks the database, so traffic is
 * only routed to instances that can serve it.
 */
export function healthRoutes(app: FastifyInstance, deps: ApiDependencies): void {
  const hidden = { schema: { hide: true } };

  app.get('/health/live', hidden, () => ({ status: 'ok' }));

  app.get('/health/ready', hidden, async (_request, reply) => {
    if (await isDatabaseReady(deps.pool)) return { status: 'ok' };
    return reply.code(503).send({ status: 'unavailable' });
  });
}
