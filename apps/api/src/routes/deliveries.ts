import type { FastifyInstance } from 'fastify';
import { notFound } from '../../../../packages/core/src/errors.js';
import { getDelivery, replayDelivery } from '../../../../packages/db/src/deliveries.js';
import { withTransaction } from '../../../../packages/db/src/pool.js';
import type { ApiDependencies } from '../app.js';
import { principalOf, projectOf, requirePermission } from '../auth.js';
import { getDeliverySchema, replayDeliverySchema } from '../schemas.js';

export function deliveryRoutes(app: FastifyInstance, deps: ApiDependencies): void {
  const manageOnly = requirePermission(deps, 'manage');

  app.get<{ Params: { id: string } }>(
    '/v1/deliveries/:id',
    { schema: getDeliverySchema, onRequest: manageOnly },
    async (request) => {
      const delivery = await getDelivery(deps.pool, projectOf(request), request.params.id);
      if (!delivery) throw notFound('Delivery');
      return delivery;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/deliveries/:id/replay',
    { schema: replayDeliverySchema, onRequest: manageOnly },
    async (request, reply) => {
      const projectId = projectOf(request);
      const { keyId } = principalOf(request);

      const result = await withTransaction(deps.pool, (client) =>
        replayDelivery(client, projectId, request.params.id, keyId),
      );
      return reply.code(202).send(result);
    },
  );
}
