// Measures API acceptance and end-to-end delivery against a running API and worker.
// Usage and method: docs/benchmarks.md
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { createPool } from '../packages/db/src/pool.js';

export interface LatencySummary {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface BenchmarkReport {
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryMb: number;
    postgresVersion: string;
  };
  configuration: {
    events: number;
    publisherConcurrency: number;
    payloadBytes: number;
    workerConcurrency: number;
  };
  durationMs: number;
  /** Events the API answered with 202. */
  accepted: number;
  /** Publish requests that did not return 202. */
  rejected: number;
  /** Deliveries created for the accepted events (one endpoint, so equal to `accepted`). */
  acceptedDeliveries: number;
  delivered: number;
  failed: number;
  /** Deliveries still pending or in flight when the benchmark stopped waiting. */
  pending: number;
  /** Requests the sink received, including at-least-once duplicates. */
  receivedBySink: number;
  acceptance: { throughputPerSecond: number; latencyMs: LatencySummary };
  delivery: {
    throughputPerSecond: number;
    /** From sending the publish request until the sink received the webhook. */
    completionLatencyMs: LatencySummary;
    /** From the API's 202 response until the sink received the webhook. */
    queueLagMs: LatencySummary;
  };
}

export interface BenchmarkSink {
  origin: string;
  /** First receipt time (performance.now) per delivery ID. */
  firstReceipt: Map<string, number>;
  requests(): number;
  close(): Promise<void>;
}

export interface BenchmarkOptions {
  apiUrl: string;
  operatorKey: string;
  /** Used only to read final delivery states and the server version. */
  pool: Pool;
  sink: BenchmarkSink;
  events: number;
  publisherConcurrency: number;
  payloadBytes: number;
  /** Reported only; configure the worker itself with WORKER_CONCURRENCY. */
  workerConcurrency: number;
  settleTimeoutMs: number;
}

/** Nearest-rank percentiles, rounded to 0.1 ms. */
export function percentiles(values: number[]): LatencySummary {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (percentile: number) => {
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return round(sorted[Math.max(0, index)] ?? 0);
  };
  return { p50: rank(50), p95: rank(95), p99: rank(99), max: round(sorted.at(-1) ?? 0) };
}

/**
 * Every accepted delivery must end up delivered, failed or still pending. A mismatch means
 * the benchmark lost track of work, so its numbers must not be published.
 */
export function verifyAccounting(counts: {
  acceptedDeliveries: number;
  delivered: number;
  failed: number;
  pending: number;
}): void {
  const accountedFor = counts.delivered + counts.failed + counts.pending;
  if (accountedFor !== counts.acceptedDeliveries) {
    throw new Error(
      `Benchmark accounting mismatch: ${counts.acceptedDeliveries} accepted but ` +
        `${accountedFor} delivered, failed or pending`,
    );
  }
}

/** A consumer that accepts everything immediately and records when each delivery arrived. */
export async function startSink(port: number, host = '127.0.0.1'): Promise<BenchmarkSink> {
  const firstReceipt = new Map<string, number>();
  let requests = 0;

  const server = createServer((request, response) => {
    const receivedAt = performance.now();
    requests += 1;
    const deliveryId = String(request.headers['x-webhook-delivery-id']);
    if (!firstReceipt.has(deliveryId)) firstReceipt.set(deliveryId, receivedAt);
    request.resume();
    request.on('end', () => {
      response.writeHead(204);
      response.end();
    });
  });
  server.listen(port, host);
  await once(server, 'listening');
  const { port: actualPort } = server.address() as AddressInfo;

  return {
    origin: `http://${host}:${actualPort}`,
    firstReceipt,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

interface PublishTiming {
  sentAt: number;
  acceptedAt: number;
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const call = async <T>(path: string, token: string, body: object) => {
    const response = await fetch(options.apiUrl + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`POST ${path} failed with ${response.status}`);
    return (await response.json()) as T;
  };

  // Setup: one project, one endpoint pointing at the sink.
  const project = await call<{ id: string }>('/v1/projects', options.operatorKey, {
    name: 'Benchmark',
  });
  const keyFor = async (permission: 'manage' | 'publish') =>
    (
      await call<{ token: string }>(`/v1/projects/${project.id}/keys`, options.operatorKey, {
        permission,
      })
    ).token;
  const manageKey = await keyFor('manage');
  const publishKey = await keyFor('publish');
  await call('/v1/endpoints', manageKey, {
    url: `${options.sink.origin}/benchmark`,
    eventTypes: ['benchmark.event'],
  });

  // The payload size is the size of the event's `data` object.
  const filler = 'x'.repeat(Math.max(0, options.payloadBytes - '{"index":0,"filler":""}'.length));

  const timings = new Map<string, PublishTiming>();
  const acceptanceLatencies: number[] = [];
  let rejected = 0;
  let next = 0;

  // Phase 1: publishers send events as fast as the API accepts them.
  const startedAt = performance.now();
  const publisher = async () => {
    while (next < options.events) {
      const index = next;
      next += 1;
      const sentAt = performance.now();
      const response = await fetch(`${options.apiUrl}/v1/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${publishKey}`,
          'content-type': 'application/json',
          'idempotency-key': `benchmark-${project.id}-${index}`,
        },
        body: JSON.stringify({ type: 'benchmark.event', data: { index, filler } }),
      });
      const acceptedAt = performance.now();
      if (response.status !== 202) {
        rejected += 1;
        await response.body?.cancel();
        continue;
      }
      const { deliveryIds } = (await response.json()) as { deliveryIds: string[] };
      acceptanceLatencies.push(acceptedAt - sentAt);
      for (const deliveryId of deliveryIds) timings.set(deliveryId, { sentAt, acceptedAt });
    }
  };
  await Promise.all(Array.from({ length: options.publisherConcurrency }, publisher));
  const publishedAt = performance.now();

  // Phase 2: wait until no delivery of this run is pending or in flight.
  const deadline = Date.now() + options.settleTimeoutMs;
  let states = await countStates(options.pool, project.id);
  while (states.pending > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    states = await countStates(options.pool, project.id);
  }
  const finishedAt = performance.now();

  const completion: number[] = [];
  const queueLag: number[] = [];
  let lastReceipt = publishedAt;
  for (const [deliveryId, timing] of timings) {
    const receivedAt = options.sink.firstReceipt.get(deliveryId);
    if (receivedAt === undefined) continue;
    completion.push(receivedAt - timing.sentAt);
    queueLag.push(receivedAt - timing.acceptedAt);
    lastReceipt = Math.max(lastReceipt, receivedAt);
  }

  const version = await options.pool.query<{ server_version: string }>('SHOW server_version');
  const report: BenchmarkReport = {
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
      postgresVersion: version.rows[0]?.server_version ?? 'unknown',
    },
    configuration: {
      events: options.events,
      publisherConcurrency: options.publisherConcurrency,
      payloadBytes: options.payloadBytes,
      workerConcurrency: options.workerConcurrency,
    },
    durationMs: round(finishedAt - startedAt),
    accepted: acceptanceLatencies.length,
    rejected,
    acceptedDeliveries: timings.size,
    ...states,
    receivedBySink: options.sink.requests(),
    acceptance: {
      throughputPerSecond: perSecond(acceptanceLatencies.length, publishedAt - startedAt),
      latencyMs: percentiles(acceptanceLatencies),
    },
    delivery: {
      throughputPerSecond: perSecond(states.delivered, lastReceipt - startedAt),
      completionLatencyMs: percentiles(completion),
      queueLagMs: percentiles(queueLag),
    },
  };

  verifyAccounting(report);
  return report;
}

async function countStates(pool: Pool, projectId: string) {
  const result = await pool.query<{ state: string; count: number }>(
    `SELECT state, count(*)::int AS count FROM deliveries
     WHERE project_id = $1 GROUP BY state`,
    [projectId],
  );
  const count = (...names: string[]) =>
    result.rows.filter((row) => names.includes(row.state)).reduce((sum, row) => sum + row.count, 0);
  return {
    delivered: count('succeeded'),
    failed: count('failed'),
    pending: count('pending', 'processing'),
  };
}

function perSecond(count: number, elapsedMs: number): number {
  return elapsedMs > 0 ? round((count * 1000) / elapsedMs) : 0;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatReport(report: BenchmarkReport): string {
  const latency = (summary: LatencySummary) =>
    `p50 ${summary.p50} / p95 ${summary.p95} / p99 ${summary.p99} / max ${summary.max} ms`;
  const { environment: env, configuration: cfg } = report;
  return [
    `Environment: ${env.cpuModel} (${env.cpuCount} CPUs), ${env.totalMemoryMb} MB RAM, ` +
      `${env.platform}/${env.arch}, Node ${env.nodeVersion}, PostgreSQL ${env.postgresVersion}`,
    `Run: ${cfg.events} events, ${cfg.payloadBytes} B payload, ` +
      `${cfg.publisherConcurrency} publishers, worker concurrency ${cfg.workerConcurrency}, ` +
      `${report.durationMs} ms total`,
    `Accepted ${report.accepted}, rejected ${report.rejected}; delivered ${report.delivered}, ` +
      `failed ${report.failed}, pending ${report.pending}; sink received ${report.receivedBySink}`,
    `API acceptance: ${report.acceptance.throughputPerSecond} events/s, ` +
      latency(report.acceptance.latencyMs),
    `Delivery: ${report.delivery.throughputPerSecond} deliveries/s`,
    `Completion latency: ${latency(report.delivery.completionLatencyMs)}`,
    `Queue lag: ${latency(report.delivery.queueLagMs)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const operatorKey = process.env.OPERATOR_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!operatorKey || !databaseUrl) {
    throw new Error('Set OPERATOR_KEY and DATABASE_URL (see docs/benchmarks.md)');
  }

  const number = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
  const sink = await startSink(number('BENCHMARK_SINK_PORT', 4100));
  const pool = createPool(databaseUrl);
  try {
    const report = await runBenchmark({
      apiUrl: process.env.API_URL ?? 'http://localhost:3000',
      operatorKey,
      pool,
      sink,
      events: number('BENCHMARK_EVENTS', 2000),
      publisherConcurrency: number('BENCHMARK_PUBLISHERS', 20),
      payloadBytes: number('BENCHMARK_PAYLOAD_BYTES', 1024),
      workerConcurrency: number('WORKER_CONCURRENCY', 4),
      settleTimeoutMs: number('BENCHMARK_SETTLE_TIMEOUT_MS', 120_000),
    });
    process.stdout.write(`${formatReport(report)}\n`);
    if (process.env.BENCHMARK_OUTPUT) {
      await writeFile(process.env.BENCHMARK_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
    }
  } finally {
    await sink.close();
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
