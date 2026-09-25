import type { FastifyInstance } from 'fastify';
import { notFound } from '../../../../packages/core/src/errors.js';
import { MAX_EVENT_DATA_BYTES, type EventInput } from '../../../../packages/core/src/events.js';
import { getEvent, publishEvent } from '../../../../packages/db/src/events.js';
import { withTransaction } from '../../../../packages/db/src/pool.js';
import type { ApiDependencies } from '../app.js';
import { projectOf, requirePermission } from '../auth.js';
import { getEventSchema, publishEventSchema } from '../schemas.js';

// Room for the event type and JSON punctuation around the 64 KiB data object.
// The exact data limit is enforced by the domain validation.
const PUBLISH_BODY_LIMIT = MAX_EVENT_DATA_BYTES + 1024;

export function eventRoutes(app: FastifyInstance, deps: ApiDependencies): void {
  app.post<{ Body: EventInput; Headers: { 'idempotency-key': string } }>(
    '/v1/events',
    {
      schema: publishEventSchema,
      onRequest: requirePermission(deps, 'publish'),
      bodyLimit: PUBLISH_BODY_LIMIT,
    },
    async (request, reply) => {
      const projectId = projectOf(request);
      const idempotencyKey = request.headers['idempotency-key'];

      const published = await withTransaction(deps.pool, (client) =>
        publishEvent(client, projectId, idempotencyKey, request.body),
      );
      return reply.code(202).send(published);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/events/:id',
    { schema: getEventSchema, onRequest: requirePermission(deps, 'manage') },
    async (request) => {
      const event = await getEvent(deps.pool, projectOf(request), request.params.id);
      if (!event) throw notFound('Event');
      return event;
    },
  );
}
