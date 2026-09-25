import swagger from '@fastify/swagger';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../../packages/core/src/config.js';
import { AppError } from '../../../packages/core/src/errors.js';
import { deliveryRoutes } from './routes/deliveries.js';
import { endpointRoutes } from './routes/endpoints.js';
import { eventRoutes } from './routes/events.js';
import { projectRoutes } from './routes/projects.js';

export interface ApiDependencies {
  pool: Pool;
  config: Config;
  logger?: FastifyServerOptions['logger'];
}

// Default for routes without their own limit; publishing events raises it.
const DEFAULT_BODY_LIMIT = 16 * 1024;

export async function buildApp(deps: ApiDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: DEFAULT_BODY_LIMIT,
    ajv: {
      // Fastify strips unknown properties by default; reject them instead so clients
      // learn about typos and cannot smuggle fields such as a project ID.
      customOptions: { removeAdditional: false },
    },
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Webhook Relay API',
        version: '0.1.0',
        description: 'Publish events and inspect their signed, at-least-once webhook deliveries.',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    if (error.validation) {
      return reply.code(400).send({ error: 'invalid_request', message: error.message });
    }
    // Framework client errors such as 413 (body too large) or 415 (unsupported media type).
    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code.toLowerCase(), message: error.message });
    }

    request.log.error({ err: error }, 'Unhandled request error');
    return reply.code(500).send({ error: 'internal_error', message: 'Internal server error' });
  });

  projectRoutes(app, deps);
  endpointRoutes(app, deps);
  eventRoutes(app, deps);
  deliveryRoutes(app, deps);

  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  await app.ready();
  return app;
}
