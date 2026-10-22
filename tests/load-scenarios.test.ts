import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { percentiles, verifyAccounting, type LatencySummary } from '../scripts/benchmark.js';
import {
  runLoadScenario,
  type LoadScenarioOptions,
  type LoadScenarioReport,
  type TenantLoadReport,
} from '../scripts/load-scenarios.js';
import { createTestDatabase, type TestDatabase } from './helpers/database.js';

// No mocks: GREEN must start the real API, worker and loopback HTTP consumer.
// Each scenario owns its projects; the throwaway database is shared only within this file.
describe('runLoadScenario', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  const optionsFor = (scenario: LoadScenarioOptions['scenario']): LoadScenarioOptions => ({
    pool: database.pool,
    databaseUrl: database.url,
    scenario,
    durationMs: 150,
    publisherRate: 20,
    noisyRate: 40,
    slowConsumerMs: 15,
    concurrency: 2,
    settleTimeoutMs: 5000,
    retryScale: 0.00001,
    payloadBytes: 128,
  });

  function expectLatency(summary: LatencySummary): void {
    for (const value of Object.values(summary)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    // Reuse the existing nearest-rank summary's field contract, not a new percentile method.
    expect(Object.keys(summary).sort()).toEqual(Object.keys(percentiles([])).sort());
    expect(summary.p50).toBeLessThanOrEqual(summary.p95);
    expect(summary.p95).toBeLessThanOrEqual(summary.p99);
    expect(summary.p99).toBeLessThanOrEqual(summary.max);
    expect(summary.max).toBeGreaterThan(0);
  }

  async function expectRealAccounting(tenant: TenantLoadReport): Promise<void> {
    expect(tenant.projectId).toMatch(/^[a-f0-9-]{36}$/);
    expect(tenant.accepted).toBeGreaterThan(0);
    expect(tenant.acceptedDeliveries).toBe(tenant.accepted); // One endpoint per project.
    expect(() => {
      verifyAccounting(tenant);
    }).not.toThrow();

    const states = await database.pool.query<{ state: string; count: number }>(
      `SELECT state, count(*)::int AS count FROM deliveries
       WHERE project_id = $1 GROUP BY state`,
      [tenant.projectId],
    );
    const count = (...names: string[]) =>
      states.rows
        .filter((row) => names.includes(row.state))
        .reduce((sum, row) => sum + row.count, 0);
    const delivered = count('succeeded');
    const failed = count('failed');
    const pending = count('pending', 'processing');
    expect(delivered + failed + pending).toBe(tenant.acceptedDeliveries);
    expect({
      delivered: tenant.delivered,
      failed: tenant.failed,
      pending: tenant.pending,
    }).toEqual({ delivered, failed, pending });

    const events = await database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM events WHERE project_id = $1',
      [tenant.projectId],
    );
    expect(events.rows[0]?.count).toBe(tenant.accepted);
    const attempts = await database.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM delivery_attempts a
       JOIN deliveries d ON d.id = a.delivery_id WHERE d.project_id = $1`,
      [tenant.projectId],
    );
    expect(tenant.attempts).toBe(attempts.rows[0]?.count);
    expect(tenant.attempts).toBeGreaterThanOrEqual(tenant.delivered);
    expect(tenant.receipts).toBeGreaterThanOrEqual(tenant.delivered);
    expect(tenant.receipts).toBeLessThanOrEqual(tenant.attempts);
    expect(tenant.publishRequests).toBe(tenant.accepted + tenant.rejected);
    expect(tenant.abortedRequests).toBeLessThanOrEqual(tenant.rejected);
    for (const value of [
      tenant.accepted,
      tenant.rejected,
      tenant.abortedRequests,
      tenant.publishRequests,
      tenant.duplicates,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(tenant.duplicates).toBeLessThanOrEqual(tenant.receipts);
    expectLatency(tenant.acceptanceLatencyMs);
    expectLatency(tenant.completionLatencyMs);

    expect(tenant.queueSamples.length).toBeGreaterThan(0);
    let previousElapsed = -1;
    for (const sample of tenant.queueSamples) {
      expect(Number.isFinite(sample.elapsedMs)).toBe(true);
      expect(sample.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(sample.elapsedMs).toBeGreaterThanOrEqual(previousElapsed);
      previousElapsed = sample.elapsedMs;
      for (const value of [sample.pending, sample.processing, sample.delivered, sample.failed]) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
    // A final DB sample is mandatory: an array of invented zero samples is not sufficient.
    expect(tenant.queueSamples.at(-1)).toMatchObject({
      pending: count('pending'),
      processing: count('processing'),
      delivered,
      failed,
    });
  }

  function expectMetadata(report: LoadScenarioReport, options: LoadScenarioOptions): void {
    const configuration = Object.fromEntries(
      Object.entries(options).filter(([key]) => key !== 'pool' && key !== 'databaseUrl'),
    );
    expect(report.configuration).toEqual({
      ...configuration,
      noisyWarmupMs: options.noisyWarmupMs ?? 0,
    });
    for (const field of [
      'publishRequests',
      'accepted',
      'rejected',
      'abortedRequests',
      'acceptedDeliveries',
      'delivered',
      'failed',
      'pending',
      'attempts',
      'receipts',
      'duplicates',
    ] as const) {
      expect(report.totals[field]).toBe(
        report.tenants.reduce((sum, tenant) => sum + tenant[field], 0),
      );
    }
    expect(() => {
      verifyAccounting(report.totals);
    }).not.toThrow();
    expect(report.environment.nodeVersion).toBe(process.version);
    expect(report.environment.platform).toBe(process.platform);
    expect(report.environment.arch).toBe(process.arch);
    expect(report.environment.cpuModel.length).toBeGreaterThan(0);
    expect(report.environment.cpuCount).toBeGreaterThan(0);
    expect(report.environment.totalMemoryMb).toBeGreaterThan(0);
    expect(report.environment.postgresVersion).toMatch(/^\d+/);
    expect(Number.isFinite(report.durationMs)).toBe(true);
    const warmupMs = options.scenario === 'noisy-neighbor' ? (options.noisyWarmupMs ?? 0) : 0;
    expect(report.durationMs).toBeGreaterThanOrEqual(options.durationMs + warmupMs);
    // The report must not expose the connection string or ephemeral API credentials.
    expect(JSON.stringify(report)).not.toContain(database.url);
    expect(report.configuration).not.toHaveProperty('pool');
    expect(report.configuration).not.toHaveProperty('databaseUrl');
  }

  it('sustains real publishing and settles every accepted delivery', async () => {
    const options = optionsFor('sustained');
    const report = await runLoadScenario(options);
    expectMetadata(report, options);
    expect(report.tenants).toHaveLength(1);
    const healthy = report.tenants[0]!;
    expect(healthy.role).toBe('healthy');
    await expectRealAccounting(healthy);
    expect(healthy.delivered).toBe(healthy.acceptedDeliveries);
    expect(healthy.failed).toBe(0);
    expect(healthy.pending).toBe(0);
  });

  it('retries two transient consumer failures per delivery before succeeding', async () => {
    const options = optionsFor('retry');
    const report = await runLoadScenario(options);
    expectMetadata(report, options);
    expect(report.tenants).toHaveLength(1);
    const healthy = report.tenants[0]!;
    expect(healthy.role).toBe('healthy');
    await expectRealAccounting(healthy);
    expect(healthy.delivered).toBe(healthy.acceptedDeliveries);
    expect(healthy.failed).toBe(0);
    expect(healthy.pending).toBe(0);
    expect(healthy.attempts).toBeGreaterThanOrEqual(healthy.acceptedDeliveries * 3);
    expect(healthy.receipts).toBeGreaterThanOrEqual(healthy.acceptedDeliveries * 3);
    const attempts = await database.pool.query<{ delivery_id: string; statuses: number[] }>(
      `SELECT a.delivery_id, array_agg(a.status_code ORDER BY a.cycle, a.number) AS statuses
       FROM delivery_attempts a JOIN deliveries d ON d.id = a.delivery_id
       WHERE d.project_id = $1 GROUP BY a.delivery_id`,
      [healthy.projectId],
    );
    expect(attempts.rows).toHaveLength(healthy.acceptedDeliveries);
    for (const row of attempts.rows) {
      expect(row.statuses.slice(0, 3)).toEqual([503, 503, 204]);
    }
  });

  it('measures separate healthy and noisy projects without a performance guarantee', async () => {
    const options = { ...optionsFor('noisy-neighbor'), noisyWarmupMs: 100 };
    const report = await runLoadScenario(options);
    expectMetadata(report, options);
    expect(report.tenants).toHaveLength(2);
    expect(report.tenants.map((tenant) => tenant.role).sort()).toEqual(['healthy', 'noisy']);
    expect(new Set(report.tenants.map((tenant) => tenant.projectId)).size).toBe(2);
    const projects = await database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM projects WHERE id = ANY($1::uuid[])',
      [report.tenants.map((tenant) => tenant.projectId)],
    );
    expect(projects.rows[0]?.count).toBe(2);
    for (const tenant of report.tenants) await expectRealAccounting(tenant);
    const healthy = report.tenants.find((tenant) => tenant.role === 'healthy')!;
    expect(healthy.baselineCompletionSamples).toBeGreaterThan(0);
    expect(healthy.contendedCompletionSamples).toBeGreaterThan(0);
    expectLatency(healthy.baselineCompletionLatencyMs!);
    expectLatency(healthy.contendedCompletionLatencyMs!);
    expect(healthy.baselineCompletionSamples! + healthy.contendedCompletionSamples!).toBe(
      healthy.delivered,
    );
    expect(healthy.delivered).toBe(healthy.acceptedDeliveries);
    expect(healthy.failed).toBe(0);
    expect(healthy.pending).toBe(0);
    // No latency/throughput threshold or fairness claim: this scenario collects evidence first.
  });

  const integerLimits = [
    ['durationMs', 1, 300_000],
    ['publisherRate', 1, 10_000],
    ['noisyRate', 1, 10_000],
    ['slowConsumerMs', 0, 10_000],
    ['concurrency', 1, 64],
    ['settleTimeoutMs', 1, 300_000],
    ['payloadBytes', 2, 65_536],
    ['noisyWarmupMs', 0, 300_000],
  ] as const;
  const invalidNumbers: { field: keyof LoadScenarioOptions; value: number }[] =
    integerLimits.flatMap(([field, min, max]) =>
      [NaN, Infinity, -Infinity, min - 1, max + 1, min + 0.5].map((value) => ({ field, value })),
    );
  invalidNumbers.push(
    ...[NaN, Infinity, -Infinity, 0, -0.1, 1.01].map((value) => ({
      field: 'retryScale' as const,
      value,
    })),
  );

  it.each(invalidNumbers)('rejects invalid $field=$value before setup', async (input) => {
    const before = await database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM projects',
    );
    const invalid = { ...optionsFor('sustained'), [input.field]: input.value };
    await expect(runLoadScenario(invalid)).rejects.toThrow(new RegExp(input.field));
    const after = await database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM projects',
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('rejects an unknown scenario at the runtime boundary', async () => {
    const invalid = { ...optionsFor('sustained'), scenario: 'unknown' };
    await expect(runLoadScenario(invalid as LoadScenarioOptions)).rejects.toThrow(/scenario/);
  });
});
