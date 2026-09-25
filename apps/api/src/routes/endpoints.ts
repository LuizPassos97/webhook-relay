import type { FastifyInstance } from 'fastify';
import { validateDestinationUrl } from '../../../../packages/core/src/destination-policy.js';
import { badRequest } from '../../../../packages/core/src/errors.js';
import {
  createEndpoint,
  listEndpoints,
  type EndpointInput,
} from '../../../../packages/db/src/endpoints.js';
import { withTransaction } from '../../../../packages/db/src/pool.js';
import type { ApiDependencies } from '../app.js';
import { projectOf, requirePermission } from '../auth.js';
import { createEndpointSchema, listEndpointsSchema } from '../schemas.js';

export function endpointRoutes(app: FastifyInstance, deps: ApiDependencies): void {
  const manageOnly = requirePermission(deps, 'manage');

  app.post<{ Body: EndpointInput }>(
    '/v1/endpoints',
    { schema: createEndpointSchema, onRequest: manageOnly },
    async (request, reply) => {
      try {
        validateDestinationUrl(request.body.url, deps.config.demoOrigin);
      } catch {
        throw badRequest('Endpoint URL must be a public HTTPS URL without credentials');
      }

      const endpoint = await withTransaction(deps.pool, (client) =>
        createEndpoint(client, projectOf(request), request.body, deps.config.masterKey),
      );
      return reply.code(201).send(endpoint);
    },
  );

  app.get<{ Querystring: { limit: number; cursor?: string } }>(
    '/v1/endpoints',
    { schema: listEndpointsSchema, onRequest: manageOnly },
    (request) => listEndpoints(deps.pool, projectOf(request), request.query),
  );
}
