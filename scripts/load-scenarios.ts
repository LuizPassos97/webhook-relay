import type { Pool } from 'pg';
import type { BenchmarkReport, LatencySummary } from './benchmark.js';

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

/**
 * RED-only placeholder. GREEN must:
 * - Validate scenario and all finite numeric bounds above before creating resources/projects.
 * - Start a loopback sink and real buildApp/startWorker in-process, production:false,
 *   demoOrigin:sink.origin; use the supplied isolated pool without changing queue production code.
 * - Provision projects/keys/endpoints through the HTTP API. Retry consumer returns 503 twice
 *   per delivery ID, then 204; noisy consumer delays by slowConsumerMs.
 *   Create/revoke a temporary operator via createOperatorKey for this isolated study DB;
 *   bootstrapOperatorKey alone cannot support repeated runs on the same database.
 * - Schedule bounded publishers for the full duration, with a healthy-only noisyWarmupMs
 *   phase before noisy publishing. Use one monotonic clock for all latency measurements.
 * - Record every request outcome, including rejects/aborts. If an unconfirmed publish committed,
 *   reconcile by idempotency key and fail accounting rather than hide unknown DB deliveries.
 * - Read states/attempts from PostgreSQL, sample the queue, reuse percentiles/verifyAccounting
 *   per tenant and for totals; expose pending work at the drain deadline honestly.
 * - Stop the worker and close API/sink/timers in finally, including partial startup failures.
 *   Freeze counters and final DB snapshots consistently before returning, leaving pool open.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Deliberate async RED-only stub.
export async function runLoadScenario(options: LoadScenarioOptions): Promise<LoadScenarioReport> {
  void options;
  throw new Error('Load scenario not implemented');
}
