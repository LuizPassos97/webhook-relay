import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../apps/api/src/app.js';
import { startWorker, type WorkerHandle } from '../apps/worker/src/runner.js';
import type { Config } from '../packages/core/src/config.js';
import { silentLogger } from '../packages/core/src/logger.js';
import { createDeliveryMetrics } from '../packages/core/src/telemetry.js';
import { createOperatorKey, type IssuedKey } from '../packages/db/src/keys.js';
import { migrate } from '../packages/db/src/migrate.js';
import { createPool, withTransaction } from '../packages/db/src/pool.js';
import {
  percentiles,
  verifyAccounting,
  type BenchmarkReport,
  type LatencySummary,
} from './benchmark.js';

export type LoadScenario = 'sustained' | 'retry' | 'noisy-neighbor';

export interface LoadScenarioOptions {
  /** Caller-owned, migrated, isolated study database. Never close this pool in the runner. */
  pool: Pool;
  /** Used for the in-process service configuration only; never include in the report. */
  databaseUrl: string;
  scenario: LoadScenario;
  /** Publishing duration (contention phase for noisy-neighbor), integer 1..300000 ms. */
  durationMs: number;
  /** Per-tenant scheduled publish requests/second, integer 1..10000. */
  publisherRate: number;
  /** Noisy project's scheduled publish requests/second, integer 1..10000. */
  noisyRate: number;
  /** Noisy consumer response delay, integer 0..10000 ms. Healthy consumer responds immediately. */
  slowConsumerMs: number;
  /** Shared real worker concurrency, integer 1..64. */
  concurrency: number;
  /** Drain deadline after publishing, integer 1..300000 ms. */
  settleTimeoutMs: number;
  /** Finite multiplier > 0 and <= 1; shortened retries are study-only, never production. */
  retryScale: number;
  /** UTF-8 JSON data object size, integer 2..65536 bytes. */
  payloadBytes: number;
  /** Default 0; integer 0..300000 ms of healthy-only publishing before contention. */
  noisyWarmupMs?: number;
}

export interface LoadCounts {
  /** Every attempted publish, including requests rejected or aborted before a response. */
  publishRequests: number;
  /** Publish requests confirmed with HTTP 202, not inferred from sink receipts. */
  accepted: number;
  /** All non-202 publishes, including network/abort failures; never silently dropped. */
  rejected: number;
  /** Subset of rejected: requests aborted or failed without an HTTP response. */
  abortedRequests: number;
  /** Sum of delivery IDs returned by accepted publishes; one endpoint per project. */
  acceptedDeliveries: number;
  /** Database state succeeded, not merely a request received at the sink. */
  delivered: number;
  failed: number;
  /** Database states pending + processing at the final snapshot. */
  pending: number;
  /** Real delivery_attempts rows in this tenant's project. */
  attempts: number;
  /** All sink requests for this tenant, including transient failures and duplicate receipts. */
  receipts: number;
  /** Successful sink receipts beyond the first success per delivery ID; excludes failed retries. */
  duplicates: number;
}

export interface QueueSample {
  /** Monotonic elapsed time from the shared study start, using performance.now(). */
  elapsedMs: number;
  pending: number;
  processing: number;
  delivered: number;
  failed: number;
}

export interface TenantLoadReport extends LoadCounts {
  projectId: string;
  role: 'healthy' | 'noisy';
  /** Publish send -> HTTP response, summarized with benchmark.percentiles. */
  acceptanceLatencyMs: LatencySummary;
  /** Publish send -> first successful sink receipt, not first failed retry receipt. */
  completionLatencyMs: LatencySummary;
  /** Real DB snapshots during publishing/drain, including the final snapshot. */
  queueSamples: QueueSample[];
  /** Healthy noisy-neighbor samples partitioned by publish send time, not completion time. */
  baselineCompletionLatencyMs?: LatencySummary;
  contendedCompletionLatencyMs?: LatencySummary;
  baselineCompletionSamples?: number;
  contendedCompletionSamples?: number;
}

export interface LoadScenarioReport {
  environment: BenchmarkReport['environment'];
  /** Normalized options only: no database URL, pool, API tokens or signing secrets. */
  configuration: Omit<LoadScenarioOptions, 'pool' | 'databaseUrl' | 'noisyWarmupMs'> & {
    noisyWarmupMs: number;
  };
  /** Warmup + publishing + drain, measured on the same performance.now() clock. */
  durationMs: number;
  tenants: TenantLoadReport[];
  /** Sum of tenant counters, independently reconciled with their project-scoped DB rows. */
  totals: LoadCounts;
}

// Study safeguards, independent of the individual option bounds. No queued promise per event.
const PUBLISHERS_PER_TENANT = 8;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_SCHEDULED_REQUESTS = 50_000;
const MAX_SCHEDULED_PAYLOAD_BYTES = 64 * 1024 * 1024;

function scenarioOf(value: string): LoadScenario {
  if (value !== 'sustained' && value !== 'retry' && value !== 'noisy-neighbor') {
    throw new Error('Invalid scenario');
  }
  return value;
}

function normalize(options: LoadScenarioOptions): LoadScenarioReport['configuration'] {
  const configuration = {
    scenario: scenarioOf(options.scenario),
    durationMs: options.durationMs,
    publisherRate: options.publisherRate,
    noisyRate: options.noisyRate,
    slowConsumerMs: options.slowConsumerMs,
    concurrency: options.concurrency,
    settleTimeoutMs: options.settleTimeoutMs,
    retryScale: options.retryScale,
    payloadBytes: options.payloadBytes,
    noisyWarmupMs: options.noisyWarmupMs ?? 0,
  };
  const limits = [
    ['durationMs', 1, 300_000],
    ['publisherRate', 1, 10_000],
    ['noisyRate', 1, 10_000],
    ['slowConsumerMs', 0, 10_000],
    ['concurrency', 1, 64],
    ['settleTimeoutMs', 1, 300_000],
    ['payloadBytes', 2, 65_536],
    ['noisyWarmupMs', 0, 300_000],
  ] as const;
  for (const [name, min, max] of limits) {
    const value = configuration[name];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`Invalid ${name}`);
    }
  }
  if (!Number.isFinite(options.retryScale) || options.retryScale <= 0 || options.retryScale > 1) {
    throw new Error('Invalid retryScale');
  }
  const noisy = configuration.scenario === 'noisy-neighbor';
  const scheduled =
    Math.ceil((configuration.durationMs * configuration.publisherRate) / 1000) +
    (noisy
      ? Math.ceil((configuration.noisyWarmupMs * configuration.publisherRate) / 1000) +
        Math.ceil((configuration.durationMs * configuration.noisyRate) / 1000)
      : 0);
  if (scheduled > MAX_SCHEDULED_REQUESTS) {
    throw new Error('Scheduled request budget exceeded (durationMs/publisherRate/noisyRate)');
  }
  if (scheduled * configuration.payloadBytes > MAX_SCHEDULED_PAYLOAD_BYTES) {
    throw new Error('Scheduled payloadBytes budget exceeded');
  }
  return configuration;
}

interface PublishRecord {
  sentAt: number;
  deliveryId?: string;
  eventId?: string;
}

interface Receipt {
  requests: number;
  successes: number;
  firstSuccess?: number;
}

interface Tenant {
  projectId: string;
  role: TenantLoadReport['role'];
  publishKey: string;
  counts: LoadCounts;
  publishes: Map<string, PublishRecord>;
  acceptance: number[];
  receipts: Map<string, Receipt>;
  queueSamples: QueueSample[];
}

function emptyCounts(): LoadCounts {
  return {
    publishRequests: 0,
    accepted: 0,
    rejected: 0,
    abortedRequests: 0,
    acceptedDeliveries: 0,
    delivered: 0,
    failed: 0,
    pending: 0,
    attempts: 0,
    receipts: 0,
    duplicates: 0,
  };
}

function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Malformed API response');
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  const result = objectOf(value)[field];
  if (typeof result !== 'string' || result.length === 0) {
    throw new Error(`Malformed API response: ${field}`);
  }
  return result;
}

async function post(apiUrl: string, path: string, token: string, body: object): Promise<unknown> {
  const response = await fetch(apiUrl + path, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Study provisioning POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as unknown;
}

async function provision(
  apiUrl: string,
  operator: IssuedKey,
  sinkOrigin: string,
  role: Tenant['role'],
): Promise<Tenant> {
  const projectId = stringField(
    await post(apiUrl, '/v1/projects', operator.token, { name: `Load study ${role}` }),
    'id',
  );
  const keyFor = async (permission: 'manage' | 'publish') =>
    stringField(
      await post(apiUrl, `/v1/projects/${projectId}/keys`, operator.token, { permission }),
      'token',
    );
  const manageKey = await keyFor('manage');
  const publishKey = await keyFor('publish');
  await post(apiUrl, '/v1/endpoints', manageKey, {
    url: `${sinkOrigin}/${projectId}`,
    eventTypes: ['study.event'],
  });
  return {
    projectId,
    role,
    publishKey,
    counts: emptyCounts(),
    publishes: new Map(),
    acceptance: [],
    receipts: new Map(),
    queueSamples: [],
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

async function queueSample(pool: Pool, tenant: Tenant, startedAt: number): Promise<QueueSample> {
  const result = await pool.query<{ state: string; count: number }>(
    `SELECT state, count(*)::int AS count FROM deliveries
     WHERE project_id = $1 GROUP BY state`,
    [tenant.projectId],
  );
  const sample: QueueSample = {
    elapsedMs: performance.now() - startedAt,
    pending: 0,
    processing: 0,
    delivered: 0,
    failed: 0,
  };
  for (const row of result.rows) {
    switch (row.state) {
      case 'pending':
      case 'processing':
      case 'failed':
        sample[row.state] += row.count;
        break;
      case 'succeeded':
        sample.delivered += row.count;
        break;
      default:
        throw new Error('Unknown database delivery state');
    }
  }
  tenant.queueSamples.push(sample);
  return sample;
}

// The raw JSON data object is exactly payloadBytes UTF-8 bytes, including insignificant
// whitespace for the tiny sizes that cannot encode a string property. ASCII filler otherwise.
function payload(size: number): string {
  return size < 8 ? `{${' '.repeat(size - 2)}}` : `{"x":"${'x'.repeat(size - 8)}"}`;
}

async function publish(apiUrl: string, tenant: Tenant, body: string): Promise<void> {
  const key = `study-${tenant.projectId}-${tenant.counts.publishRequests}`;
  const record: PublishRecord = { sentAt: performance.now() };
  tenant.publishes.set(key, record);
  tenant.counts.publishRequests += 1;
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${apiUrl}/v1/events`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${tenant.publishKey}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body,
    });
  } catch {
    tenant.counts.rejected += 1;
    tenant.counts.abortedRequests += 1;
    return;
  }
  const respondedAt = performance.now();
  if (response.status !== 202) {
    tenant.counts.rejected += 1;
    await response.body?.cancel();
    return;
  }
  try {
    text = await response.text();
  } catch (error) {
    throw new Error('Unable to read HTTP 202 publish accounting', { cause: error });
  }
  // Do not treat an invalid 202 as a harmless network rejection: accounting is unknown.
  const result = objectOf(JSON.parse(text) as unknown);
  const eventId = stringField(result, 'eventId');
  const ids = result.deliveryIds;
  if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string') {
    throw new Error('Malformed publish accounting: expected one delivery ID');
  }
  record.deliveryId = ids[0];
  record.eventId = eventId;
  tenant.counts.accepted += 1;
  tenant.counts.acceptedDeliveries += ids.length;
  tenant.acceptance.push(respondedAt - record.sentAt);
}

async function publishPhase(
  apiUrl: string,
  tenant: Tenant,
  rate: number,
  start: number,
  duration: number,
  body: string,
  checkSampler: () => void,
): Promise<void> {
  let next = 0;
  const end = start + duration;
  const publisher = async () => {
    while (performance.now() < end) {
      checkSampler();
      const due = start + (next++ * 1000) / rate;
      if (due >= end) return;
      // Backpressure is deliberate: only eight requests/tenant may be in flight. If the
      // service cannot keep up, stop at the phase deadline instead of building a backlog.
      while (performance.now() < due) await delay(Math.max(1, due - performance.now()));
      if (performance.now() >= end) return;
      await publish(apiUrl, tenant, body);
    }
  };
  const results = await Promise.allSettled(Array.from({ length: PUBLISHERS_PER_TENANT }, publisher));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw new Error('Study publisher failed', { cause: failed.reason });
  while (performance.now() < end) await delay(Math.max(1, end - performance.now()));
  checkSampler();
}

async function tenantReport(
  pool: Pool,
  tenant: Tenant,
  startedAt: number,
  contentionAt: number,
  scenario: LoadScenario,
): Promise<TenantLoadReport> {
  const final = await queueSample(pool, tenant, startedAt);
  const events = await pool.query<{ id: string; idempotency_key: string; delivery_id: string | null }>(
    `SELECT e.id, e.idempotency_key, d.id AS delivery_id FROM events e
     LEFT JOIN deliveries d ON d.project_id = e.project_id AND d.event_id = e.id
     WHERE e.project_id = $1`,
    [tenant.projectId],
  );
  // This also detects publishes that committed after a lost/aborted HTTP response. We
  // cannot call those HTTP-accepted, nor silently exclude them from the DB denominator.
  for (const row of events.rows) {
    const known = tenant.publishes.get(row.idempotency_key);
    if (known?.eventId !== row.id || known?.deliveryId !== row.delivery_id) {
      throw new Error('Study accounting mismatch: unconfirmed or unknown committed publish');
    }
  }
  if (events.rows.length !== tenant.counts.accepted) {
    throw new Error('Study accounting mismatch: accepted events missing or unexpected fanout');
  }
  const attempts = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM delivery_attempts a
     JOIN deliveries d ON d.id = a.delivery_id WHERE d.project_id = $1`,
    [tenant.projectId],
  );
  const attemptCount = attempts.rows[0]?.count;
  if (attemptCount === undefined) throw new Error('Missing database attempt count');
  Object.assign(tenant.counts, {
    delivered: final.delivered,
    failed: final.failed,
    pending: final.pending + final.processing,
    attempts: attemptCount,
  });
  const completion: number[] = [];
  const baseline: number[] = [];
  const contended: number[] = [];
  const knownDeliveries = new Set<string>();
  for (const record of tenant.publishes.values()) {
    if (record.deliveryId === undefined) continue;
    if (knownDeliveries.has(record.deliveryId)) throw new Error('Duplicate accepted delivery ID');
    knownDeliveries.add(record.deliveryId);
    const success = tenant.receipts.get(record.deliveryId)?.firstSuccess;
    if (success === undefined) continue;
    const latency = success - record.sentAt;
    completion.push(latency);
    (record.sentAt < contentionAt ? baseline : contended).push(latency);
  }
  for (const [id, receipt] of tenant.receipts) {
    if (!knownDeliveries.has(id)) throw new Error('Study accounting mismatch: unknown sink receipt');
    tenant.counts.receipts += receipt.requests;
    tenant.counts.duplicates += Math.max(0, receipt.successes - 1);
  }
  if (tenant.counts.publishRequests !== tenant.counts.accepted + tenant.counts.rejected) {
    throw new Error('Study publish outcome accounting mismatch');
  }
  verifyAccounting(tenant.counts);
  return {
    projectId: tenant.projectId,
    role: tenant.role,
    ...tenant.counts,
    acceptanceLatencyMs: percentiles(tenant.acceptance),
    completionLatencyMs: percentiles(completion),
    queueSamples: tenant.queueSamples,
    ...(scenario === 'noisy-neighbor' && tenant.role === 'healthy'
      ? {
          baselineCompletionLatencyMs: percentiles(baseline),
          contendedCompletionLatencyMs: percentiles(contended),
          baselineCompletionSamples: baseline.length,
          contendedCompletionSamples: contended.length,
        }
      : {}),
  };
}

/** Runs only against a caller-provided, migrated, dedicated study database. */
export async function runLoadScenario(options: LoadScenarioOptions): Promise<LoadScenarioReport> {
  const configuration = normalize(options); // No resources or rows before validation.
  const tenants: Tenant[] = [];
  const sinkTimers = new Set<NodeJS.Timeout>();
  const samplerAbort = new AbortController();
  let sampler: Promise<void> | undefined;
  let samplerError: Error | undefined;
  const checkSampler = () => {
    if (samplerError) throw samplerError;
  };
  let api: FastifyInstance | undefined;
  let worker: WorkerHandle | undefined;
  let operator: IssuedKey | undefined;
  let inFlight = 0;
  const sink = createServer((request, response) => {
    const tenant = tenants.find((entry) => request.url === `/${entry.projectId}`);
    const deliveryId = request.headers['x-webhook-delivery-id'];
    if (!tenant || typeof deliveryId !== 'string' || deliveryId.length === 0) {
      request.resume();
      response.writeHead(400).end();
      return;
    }
    const receipt: Receipt = tenant.receipts.get(deliveryId) ?? { requests: 0, successes: 0 };
    tenant.receipts.set(deliveryId, receipt);
    receipt.requests += 1;
    const status = configuration.scenario === 'retry' && receipt.requests <= 2 ? 503 : 204;
    request.resume();
    request.on('end', () => {
      const finish = () => {
        if (response.destroyed) return;
        if (status === 204) {
          receipt.successes += 1;
          receipt.firstSuccess ??= performance.now();
        }
        response.writeHead(status).end();
      };
      if (tenant.role === 'noisy' && configuration.slowConsumerMs > 0) {
        const timer = setTimeout(() => {
          sinkTimers.delete(timer);
          finish();
        }, configuration.slowConsumerMs);
        sinkTimers.add(timer);
      } else finish();
    });
  });
  const stopWorker = async () => {
    if (!worker) return;
    await worker.stop();
    // WorkerHandle.stop has its own drain deadline. Track its real processClaim lifecycle
    // as well, so a timed-out stop can never produce a supposedly frozen DB snapshot.
    const deadline = performance.now() + 30_000;
    while (inFlight > 0 && performance.now() < deadline) await delay(10);
    if (inFlight !== 0) throw new Error('Worker still has deliveries in flight after shutdown');
    worker = undefined;
  };
  try {
    sink.listen(0, '127.0.0.1');
    await once(sink, 'listening');
    const sinkOrigin = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    const timeoutMs = Math.max(5000, configuration.slowConsumerMs + 1000);
    const config: Config = {
      databaseUrl: options.databaseUrl,
      masterKey: randomBytes(32),
      production: false,
      demoOrigin: sinkOrigin,
      port: 0,
      workerPort: 0,
      concurrency: configuration.concurrency,
      timeoutMs,
      leaseMs: timeoutMs * 4,
      maxAttempts: 5,
      retentionDays: 30,
      rateLimit: 10_000,
      retryScale: configuration.retryScale,
      pollIntervalMs: 5,
    };
    operator = await withTransaction(options.pool, createOperatorKey);
    api = await buildApp({ pool: options.pool, config });
    const apiUrl = await api.listen({ host: '127.0.0.1', port: 0 });
    tenants.push(await provision(apiUrl, operator, sinkOrigin, 'healthy'));
    if (configuration.scenario === 'noisy-neighbor') {
      tenants.push(await provision(apiUrl, operator, sinkOrigin, 'noisy'));
    }
    const metrics = createDeliveryMetrics();
    worker = startWorker({
      pool: options.pool,
      config,
      logger: silentLogger,
      metrics: {
        ...metrics,
        inFlight: {
          add(value, attributes, context) {
            inFlight += value;
            metrics.inFlight.add(value, attributes, context);
          },
        },
      },
    });
    const startedAt = performance.now();
    const warmup = configuration.scenario === 'noisy-neighbor' ? configuration.noisyWarmupMs : 0;

    const sampleAll = async () => {
      for (const tenant of tenants) await queueSample(options.pool, tenant, startedAt);
    };
    await sampleAll();
    sampler = (async () => {
      try {
        while (!samplerAbort.signal.aborted) {
          await delay(1000, undefined, { signal: samplerAbort.signal });
          await sampleAll();
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError' && samplerAbort.signal.aborted)) {
          samplerError = new Error('Study queue sampler failed', { cause: error });
        }
      }
    })();
    const body = `{"type":"study.event","data":${payload(configuration.payloadBytes)}}`;
    const healthy = tenants.find((tenant) => tenant.role === 'healthy');
    if (!healthy) throw new Error('Missing healthy study project');
    if (warmup > 0) {
      await publishPhase(
        apiUrl,
        healthy,
        configuration.publisherRate,
        performance.now(),
        warmup,
        body,
        checkSampler,
      );
    }
    // Record the actual boundary, including any last warmup response that took time to drain.
    const contentionAt = performance.now();
    const phases = await Promise.allSettled(
      tenants.map((tenant) =>
        publishPhase(
          apiUrl,
          tenant,
          tenant.role === 'noisy' ? configuration.noisyRate : configuration.publisherRate,
          contentionAt,
          configuration.durationMs,
          body,
          checkSampler,
        ),
      ),
    );
    const failedPhase = phases.find((phase) => phase.status === 'rejected');
    if (failedPhase) throw new Error('Study publishing phase failed', { cause: failedPhase.reason });
    const drainDeadline = performance.now() + configuration.settleTimeoutMs;
    for (;;) {
      checkSampler();
      const pending = await options.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM deliveries
         WHERE project_id = ANY($1::uuid[]) AND state IN ('pending', 'processing')`,
        [tenants.map((tenant) => tenant.projectId)],
      );
      if (pending.rows[0]?.count === 0 || performance.now() >= drainDeadline) break;
      await delay(Math.min(25, Math.max(1, drainDeadline - performance.now())));
    }
    await stopWorker();
    await api.close();
    api = undefined;
    await closeServer(sink);
    samplerAbort.abort();
    await sampler;
    checkSampler();
    const reports: TenantLoadReport[] = [];
    for (const tenant of tenants) {
      reports.push(
        await tenantReport(options.pool, tenant, startedAt, contentionAt, configuration.scenario),
      );
    }
    const totals = emptyCounts();
    for (const tenant of reports) {
      for (const field of Object.keys(totals) as (keyof LoadCounts)[]) totals[field] += tenant[field];
    }
    verifyAccounting(totals);
    const version = await options.pool.query<{ server_version: string }>('SHOW server_version');
    const postgresVersion = version.rows[0]?.server_version;
    if (!postgresVersion) throw new Error('Missing PostgreSQL version');
    return {
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
        totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
        postgresVersion,
      },
      configuration,
      durationMs: performance.now() - startedAt,
      tenants: reports,
      totals,
    };
  } finally {
    samplerAbort.abort();
    // Nested finally blocks preserve cleanup even when startup/shutdown partially fails.
    try {
      await sampler;
      await stopWorker();
    } finally {
      try {
        await api?.close();
      } finally {
        for (const timer of sinkTimers) clearTimeout(timer);
        try {
          await closeServer(sink);
        } finally {
          if (operator) {
            const revoked = await options.pool.query<{ id: string }>(
              `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
               WHERE id = $1 AND project_id IS NULL AND permission = 'operator' RETURNING id`,
              [operator.id],
            );
            if (revoked.rowCount !== 1) throw new Error('Study operator revocation failed');
            const verified = await options.pool.query<{ revoked: boolean }>(
              'SELECT revoked_at IS NOT NULL AS revoked FROM api_keys WHERE id = $1',
              [operator.id],
            );
            if (verified.rows[0]?.revoked !== true) throw new Error('Study operator still active');
          }
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const scenario = scenarioOf(process.env.LOAD_STUDY_SCENARIO ?? 'sustained');
  // This CLI deliberately accepts DATABASE_URL only: the workflow owns its ephemeral DB.
  const databaseUrl = process.env.DATABASE_URL;
  let validDatabaseUrl = false;
  try {
    validDatabaseUrl =
      databaseUrl !== undefined && /^postgres(ql)?:$/.test(new URL(databaseUrl).protocol);
  } catch {
    // URL parser errors may include their input: do not propagate a connection credential.
  }
  if (!databaseUrl || !validDatabaseUrl) {
    throw new Error('Set DATABASE_URL to the dedicated ephemeral study database');
  }
  const number = (name: string, fallback: number) => Number(process.env[`LOAD_STUDY_${name}`] ?? fallback);
  const pool = createPool(databaseUrl);
  try {
    const options: LoadScenarioOptions = {
      pool,
      databaseUrl,
      scenario,
      durationMs: number('DURATION_MS', scenario === 'sustained' ? 60_000 : 30_000),
      publisherRate: number(
        'PUBLISHER_RATE',
        scenario === 'sustained' ? 50 : scenario === 'retry' ? 20 : 2,
      ),
      noisyRate: number('NOISY_RATE', 40),
      slowConsumerMs: number('SLOW_CONSUMER_MS', 250),
      noisyWarmupMs: number('NOISY_WARMUP_MS', scenario === 'noisy-neighbor' ? 5000 : 0),
      concurrency: number('CONCURRENCY', 4),
      settleTimeoutMs: number('SETTLE_TIMEOUT_MS', 90_000),
      retryScale: number('RETRY_SCALE', scenario === 'retry' ? 0.0001 : 1),
      payloadBytes: number('PAYLOAD_BYTES', 1024),
    };
    normalize(options);
    await migrate(pool);
    const report = await runLoadScenario(options);
    const output = process.env.LOAD_STUDY_OUTPUT ?? 'artifacts/load-study.json';
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      `${JSON.stringify(
        {
          ...report,
          provenance: {
            commit: process.env.LOAD_STUDY_COMMIT ?? null,
            runUrl: process.env.LOAD_STUDY_RUN_URL ?? null,
            repetition: process.env.LOAD_STUDY_REPETITION ?? null,
            timestamp: new Date().toISOString(),
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
