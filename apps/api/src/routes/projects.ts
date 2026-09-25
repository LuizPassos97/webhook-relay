import type { FastifyInstance } from 'fastify';
import { notFound } from '../../../../packages/core/src/errors.js';
import { createProjectKey, type ProjectPermission } from '../../../../packages/db/src/keys.js';
import { withTransaction } from '../../../../packages/db/src/pool.js';
import { createProject, projectExists } from '../../../../packages/db/src/projects.js';
import type { ApiDependencies } from '../app.js';
import { requirePermission } from '../auth.js';
import { createKeySchema, createProjectSchema } from '../schemas.js';

export function projectRoutes(app: FastifyInstance, deps: ApiDependencies): void {
  const operatorOnly = requirePermission(deps, 'operator');

  app.post<{ Body: { name: string } }>(
    '/v1/projects',
    { schema: createProjectSchema, onRequest: operatorOnly },
    async (request, reply) => {
      const project = await withTransaction(deps.pool, (client) =>
        createProject(client, request.body.name),
      );
      return reply.code(201).send(project);
    },
  );

  app.post<{ Params: { id: string }; Body: { permission: ProjectPermission } }>(
    '/v1/projects/:id/keys',
    { schema: createKeySchema, onRequest: operatorOnly },
    async (request, reply) => {
      const key = await withTransaction(deps.pool, async (client) => {
        if (!(await projectExists(client, request.params.id))) throw notFound('Project');
        return createProjectKey(client, request.params.id, request.body.permission);
      });
      return reply.code(201).send(key);
    },
  );
}
