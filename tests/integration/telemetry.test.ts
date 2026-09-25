import { trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { runBatch } from '../../apps/worker/src/runner.js';
import type { Config } from '../../packages/core/src/config.js';
import { silentLogger } from '../../packages/core/src/logger.js';
import {
  createApiMetrics,
  createDeliveryMetrics,
  observeQueueAge,
} from '../../packages/core/src/telemetry.js';
import { oldestDueAgeSeconds } from '../../packages/db/src/deliveries.js';
import { createOperatorKey } from '../../packages/db/src/keys.js';
import { withTransaction } from '../../packages/db/src/pool.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { respondWith, startReceiver, type TestReceiver } from '../helpers/receiver.js';

/** Collects metrics on demand instead of exporting them periodically. */
class TestMetricReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const spans = new InMemorySpanExporter();
const metricReader = new TestMetricReader();
const meterProvider = new MeterProvider({ readers: [metricReader] });
const meter = meterProvider.getMeter('test');

let database: TestDatabase;
let receiver: TestReceiver;
let app: FastifyInstance;
let config: Config;
let operatorToken: string;

beforeAll(async () => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }),
  );

  database = await createTestDatabase();
  receiver = await startReceiver(respondWith(200));
  config = {
    databaseUrl: database.url,
    masterKey: Buffer.alloc(32, 4),
    production: false,
    demoOrigin: receiver.origin,
    port: 0,
    workerPort: 0,
    concurrency: 4,
    timeoutMs: 1000,
    leaseMs: 5000,
    maxAttempts: 5,
    retentionDays: 30,
    rateLimit: 1000,
    retryScale: 1,
    pollIntervalMs: 20,
  };
  app = await buildApp({ pool: database.pool, config, metrics: createApiMetrics(meter) });
  const operator = await withTransaction(database.pool, (client) => createOperatorKey(client));
  operatorToken = operator.token;
});

afterAll(async () => {
  await app.close();
  await receiver.close();
  await database.drop();
  await meterProvider.shutdown();
});

async function call<T>(method: 'GET' | 'POST', url: string, token: string, payload?: object) {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'trace-test' },
    payload,
  });
  return response.json<T>();
}

function findMetric(collected: ResourceMetrics, name: string) {
  for (const scope of collected.scopeMetrics) {
    const metric = scope.metrics.find((candidate) => candidate.descriptor.name === name);
    if (metric) return metric;
  }
  throw new Error(`Metric ${name} was not recorded`);
}

describe('telemetry', () => {
  it('links the publishing request and the delivery attempt in one trace', async () => {
    const project = await call<{ id: string }>('POST', '/v1/projects', operatorToken, {
      name: 'Telemetry',
    });
    const manage = await call<{ token: string }>(
      'POST',
      `/v1/projects/${project.id}/keys`,
      operatorToken,
      { permission: 'manage' },
    );
    const publish = await call<{ token: string }>(
      'POST',
      `/v1/projects/${project.id}/keys`,
      operatorToken,
      { permission: 'publish' },
    );
    await call('POST', '/v1/endpoints', manage.token, {
      url: `${receiver.origin}/hook`,
      eventTypes: ['order.created'],
    });
    spans.reset();

    const published = await call<{ eventId: string; deliveryIds: string[] }>(
      'POST',
      '/v1/events',
      publish.token,
      { type: 'order.created', data: { secretValue: 'do-not-export' } },
    );
    await runBatch({
      pool: database.pool,
      config,
      logger: silentLogger,
      metrics: createDeliveryMetrics(meter),
    });

    const finished = spans.getFinishedSpans();
    const requestSpan = finished.find((span) => span.name === 'POST /v1/events');
    const deliverySpan = finished.find((span) => span.name === 'webhook.deliver');
    if (!requestSpan || !deliverySpan) throw new Error('Expected request and delivery spans');

    expect(deliverySpan.spanContext().traceId).toBe(requestSpan.spanContext().traceId);
    expect(deliverySpan.parentSpanContext?.spanId).toBe(requestSpan.spanContext().spanId);
    expect(deliverySpan.attributes).toMatchObject({
      'webhook.delivery.id': published.deliveryIds[0],
      'webhook.event.id': published.eventId,
      'webhook.attempt.number': 1,
      'webhook.attempt.outcome': 'response',
      'http.response.status_code': 200,
    });

    // Neither payloads nor project identifiers leave the process through telemetry.
    const exported = JSON.stringify(finished.map((span) => span.attributes));
    expect(exported).not.toContain('do-not-export');
    expect(exported).not.toContain(project.id);
  });

  it('records request latency, attempt outcomes and queue age without project labels', async () => {
    const { rows } = await database.pool.query<{ id: string }>(
      `UPDATE deliveries SET state = 'pending', next_attempt_at = now() - interval '90 seconds'
       RETURNING id`,
    );
    expect(rows.length).toBeGreaterThan(0);
    observeQueueAge(meter, () => oldestDueAgeSeconds(database.pool));

    const { resourceMetrics } = await metricReader.collect();

    const requests = findMetric(resourceMetrics, 'webhook.api.request.duration');
    expect(requests.dataPoints.map((point) => point.attributes)).toContainEqual({
      'http.request.method': 'POST',
      'http.route': '/v1/events',
      'http.response.status_code': 202,
    });

    const attempts = findMetric(resourceMetrics, 'webhook.delivery.attempts');
    expect(attempts.dataPoints.map((point) => point.attributes)).toContainEqual({
      'webhook.attempt.outcome': 'response',
      'webhook.delivery.next_state': 'succeeded',
    });

    const queueAge = findMetric(resourceMetrics, 'webhook.queue.age');
    expect(Number(queueAge.dataPoints[0]?.value)).toBeGreaterThanOrEqual(89);

    const labels = JSON.stringify(
      resourceMetrics.scopeMetrics.flatMap((scope) =>
        scope.metrics.flatMap((metric) => metric.dataPoints.map((point) => point.attributes)),
      ),
    );
    // Route templates such as /v1/projects/:id are fine; concrete IDs are not.
    expect(labels).not.toMatch(/project_?id/i);
    expect(labels).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
