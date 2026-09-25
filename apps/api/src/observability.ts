import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  contextFromTraceParent,
  createApiMetrics,
  tracer,
  type ApiMetrics,
} from '../../../packages/core/src/telemetry.js';

declare module 'fastify' {
  interface FastifyRequest {
    span?: Span;
  }
}

/**
 * Traces every request and records its latency.
 *
 * Span and metric names use the route template (`/v1/events/:id`), never the concrete URL,
 * so IDs do not end up in telemetry. An incoming `traceparent` header continues the caller's
 * trace; otherwise each request starts a new one.
 */
export function registerObservability(app: FastifyInstance, metrics?: ApiMetrics): void {
  const { requestDuration } = metrics ?? createApiMetrics();

  app.addHook('onRequest', (request, _reply, done) => {
    const route = routeOf(request);
    const traceParent = request.headers.traceparent;
    request.span = tracer().startSpan(
      `${request.method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: { 'http.request.method': request.method, 'http.route': route },
      },
      contextFromTraceParent(typeof traceParent === 'string' ? traceParent : undefined),
    );
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const statusCode = reply.statusCode;
    request.span?.setAttribute('http.response.status_code', statusCode);
    if (statusCode >= 500) request.span?.setStatus({ code: SpanStatusCode.ERROR });
    request.span?.end();

    requestDuration.record(reply.elapsedTime, {
      'http.request.method': request.method,
      'http.route': routeOf(request),
      'http.response.status_code': statusCode,
    });
    done();
  });
}

function routeOf(request: FastifyRequest): string {
  // Unmatched URLs share one label instead of creating a series per path.
  return request.routeOptions.url ?? 'unmatched';
}
