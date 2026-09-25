import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/app.js';
import { startWorker, type WorkerHandle } from '../apps/worker/src/runner.js';
import type { Config } from '../packages/core/src/config.js';
import { silentLogger } from '../packages/core/src/logger.js';
import { bootstrapOperatorKey } from '../packages/db/src/keys.js';
import {
  percentiles,
  runBenchmark,
  startSink,
  verifyAccounting,
  type BenchmarkReport,
  type BenchmarkSink,
} from '../scripts/benchmark.js';
import { createTestDatabase, type TestDatabase } from './helpers/database.js';

describe('percentiles', () => {
  it('uses the nearest-rank method', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentiles(values)).toEqual({ p50: 50, p95: 95, p99: 99, max: 100 });
  });

  it('returns zeros for an empty sample', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 });
  });
});

describe('verifyAccounting', () => {
  const counts = { acceptedDeliveries: 10, delivered: 7, failed: 1, pending: 2 };

  it('accepts reports where every accepted delivery is accounted for', () => {
    expect(() => {
      verifyAccounting(counts);
    }).not.toThrow();
  });

  it.each([
    { ...counts, delivered: 6 },
    { ...counts, pending: 3 },
    { ...counts, acceptedDeliveries: 11 },
  ])('rejects %j', (report) => {
    expect(() => {
      verifyAccounting(report);
    }).toThrow(/accounting/i);
  });
});

describe('runBenchmark', () => {
  let database: TestDatabase;
  let api: FastifyInstance;
  let worker: WorkerHandle;
  let sink: BenchmarkSink;
  let report: BenchmarkReport;

  beforeAll(async () => {
    database = await createTestDatabase();
    sink = await startSink(0);
    const config: Config = {
      databaseUrl: database.url,
      masterKey: Buffer.alloc(32, 6),
      production: false,
      demoOrigin: sink.origin,
      port: 0,
      workerPort: 0,
      concurrency: 8,
      timeoutMs: 1000,
      leaseMs: 5000,
      maxAttempts: 5,
      retentionDays: 30,
      rateLimit: 10000,
      retryScale: 1,
      pollIntervalMs: 10,
    };
    api = await buildApp({ pool: database.pool, config });
    await api.listen({ port: 0, host: '127.0.0.1' });
    worker = startWorker({ pool: database.pool, config, logger: silentLogger });
    const operator = await bootstrapOperatorKey(database.pool);
    if (!operator) throw new Error('Expected a fresh installation');

    report = await runBenchmark({
      apiUrl: `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`,
      operatorKey: operator.token,
      pool: database.pool,
      sink,
      events: 60,
      publisherConcurrency: 6,
      payloadBytes: 512,
      workerConcurrency: config.concurrency,
      settleTimeoutMs: 20_000,
    });
  }, 40_000);

  afterAll(async () => {
    await worker.stop();
    await api.close();
    await sink.close();
    await database.drop();
  });

  it('accounts for every accepted delivery', () => {
    expect(report.accepted).toBe(60);
    expect(report.acceptedDeliveries).toBe(60);
    expect(report.accepted).toBe(report.delivered + report.failed + report.pending);
    expect(report.delivered).toBe(60);
    expect(report.receivedBySink).toBeGreaterThanOrEqual(report.delivered);
  });

  it('separates API acceptance from successful delivery', () => {
    expect(report.acceptance.throughputPerSecond).toBeGreaterThan(0);
    expect(report.acceptance.latencyMs.p50).toBeGreaterThan(0);
    expect(report.delivery.completionLatencyMs.p50).toBeGreaterThanOrEqual(
      report.acceptance.latencyMs.p50,
    );
    expect(report.delivery.queueLagMs.p99).toBeLessThanOrEqual(
      report.delivery.completionLatencyMs.max,
    );
  });

  it('records the environment and configuration it ran with', () => {
    expect(report.environment.nodeVersion).toMatch(/^v24\./);
    expect(report.environment.postgresVersion).toMatch(/^\d+/);
    expect(report.environment.cpuCount).toBeGreaterThan(0);
    expect(report.configuration).toMatchObject({
      events: 60,
      publisherConcurrency: 6,
      payloadBytes: 512,
      workerConcurrency: 8,
    });
    expect(report.durationMs).toBeGreaterThan(0);
  });
});
