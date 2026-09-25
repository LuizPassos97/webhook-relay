import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { forbidden, tooManyRequests, unauthorized } from '../../../packages/core/src/errors.js';
import {
  findActiveKey,
  type KeyPrincipal,
  type Permission,
} from '../../../packages/db/src/keys.js';
import { consumeRateLimit } from '../../../packages/db/src/rate-limits.js';
import type { ApiDependencies } from './app.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: KeyPrincipal;
  }
}

const BEARER_PATTERN = /^Bearer ([\x21-\x7e]+)$/;

/**
 * Builds an `onRequest` hook that authenticates the caller and checks the route's permission.
 *
 * It runs before the body is parsed or validated, so unauthenticated clients get 401 without
 * the server doing any work on their payload. Project keys are then rate limited per project.
 */
export function requirePermission(
  deps: ApiDependencies,
  permission: Permission,
): onRequestAsyncHookHandler {
  return async (request, reply) => {
    const match = BEARER_PATTERN.exec(request.headers.authorization ?? '');
    const token = match?.[1];
    if (!token) throw unauthorized();

    const principal = await findActiveKey(deps.pool, token);
    if (!principal) throw unauthorized();
    if (principal.permission !== permission) throw forbidden();

    if (principal.projectId !== null) {
      const decision = await consumeRateLimit(
        deps.pool,
        `project:${principal.projectId}`,
        deps.config.rateLimit,
      );
      if (!decision.allowed) {
        void reply.header('retry-after', String(decision.retryAfterSeconds));
        throw tooManyRequests();
      }
    }

    request.principal = principal;
  };
}

/** Returns the authenticated key. Only valid on routes guarded by `requirePermission`. */
export function principalOf(request: FastifyRequest): KeyPrincipal {
  if (!request.principal) throw unauthorized();
  return request.principal;
}

/** Returns the caller's project. Project data is always scoped by the key, never by the client. */
export function projectOf(request: FastifyRequest): string {
  const { projectId } = principalOf(request);
  if (projectId === null) throw forbidden();
  return projectId;
}
