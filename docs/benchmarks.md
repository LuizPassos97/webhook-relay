# Benchmarks

This page records how fast one API process and one worker process accept and deliver events on a laptop, and how to reproduce the measurement. Everything below was measured; nothing is extrapolated.

## Method

`scripts/benchmark.ts` runs against an API and a worker that are already running:

1. It creates a project, keys and one endpoint pointing at a local **sink**: an HTTP server in the benchmark process that answers `204` immediately and records when each delivery first arrives.
2. **Acceptance phase:** 20 concurrent publishers send 2,000 events with a 1 KiB `data` object as fast as the API answers. Acceptance latency is the time until the `202` response.
3. **Delivery phase:** the benchmark waits until no delivery of the run is pending or in flight, then reads the final states from PostgreSQL.
4. **Accounting check:** every accepted delivery must be delivered, failed or still pending. If the numbers do not add up, the benchmark fails instead of printing results (`verifyAccounting`, covered by `tests/benchmark.test.ts`).

Metrics:

- **API acceptance throughput and latency:** events answered with `202` per second, and per-request latency. This is only the durable write; nothing has been delivered yet.
- **Delivery throughput:** successful deliveries per second, from the first publish to the last receipt.
- **Completion latency:** from sending the publish request until the sink receives the webhook.
- **Queue lag:** from the `202` response until the sink receives the webhook.

Percentiles use the nearest-rank method. Each configuration was run three times; tables show the median with the range in parentheses.

## Environment

| Item            | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| Machine         | Apple M4, 10 CPU cores, 16 GiB RAM, macOS 27.0                                         |
| Runtime         | Node.js v24.12.0, one API process, one worker process                                  |
| Database        | PostgreSQL 18.6 in Docker Desktop 29.1.2 (VM with 10 CPUs and 8 GiB), default settings |
| Network         | Everything on the same machine; the sink adds no network latency                       |
| API settings    | `RATE_LIMIT_PER_MINUTE=10000`, `LOG_LEVEL=warn`, telemetry disabled                    |
| Worker settings | `WORKER_POLL_MS=100`, default timeout and lease                                        |
| Date            | 2026-09-25, commit of this page                                                        |

## Results

2,000 events, 1 KiB payload, 20 publishers. All runs: 2,000 accepted, 0 rejected, 2,000 delivered, 0 failed, 0 pending, 0 duplicates.

| Worker concurrency | API acceptance (events/s) | Acceptance p50 / p95 / p99 (ms) | Delivery (deliveries/s) | Completion p50 / p95 / p99 (ms) | Queue lag p50 / p99 (ms) | Duration (ms)       |
| ------------------ | ------------------------- | ------------------------------- | ----------------------- | ------------------------------- | ------------------------ | ------------------- |
| 4                  | 1,823 (1,756–1,890)       | 10.7 / 14.0 / 17.6              | 841 (813–849)           | 1,036 / 1,264 / 1,283           | 1,025 / 1,273            | 2,416 (2,360–2,479) |
| 16                 | 1,581 (1,502–1,598)       | 12.1 / 18.1 / 25.7              | 1,240 (1,218–1,319)     | 335 / 401 / 406                 | 323 / 394                | 1,647 (1,568–1,687) |

## Interpretation

- **Acceptance is not delivery.** The API accepted events about twice as fast as a worker with concurrency 4 could deliver them, so a backlog formed during the burst and queue lag grew to about one second. The `webhook.queue.age` metric exposes exactly this condition in production.
- **Worker concurrency matters most for delivery.** Raising it from 4 to 16 increased delivery throughput by about 47% and cut median completion latency by about two thirds. Acceptance throughput dropped slightly because the API, the worker and PostgreSQL share the same CPUs on this machine.
- **The sink answers instantly.** Real consumers take tens or hundreds of milliseconds per request, so delivery throughput per worker is then bounded by `WORKER_CONCURRENCY / consumer latency`. Add workers or concurrency accordingly.

## Limitations

- A single laptop runs every component, and PostgreSQL runs in a Docker Desktop VM with default settings. Production servers, tuned PostgreSQL and real networks will give different numbers.
- Runs are short bursts of 2,000 events; they do not show long-term behavior such as table bloat, autovacuum or retention cleanup under load.
- Only the success path is measured. Retries add database writes per attempt and are covered by correctness tests, not by this benchmark.

## Reproduce

With PostgreSQL running (`docker compose up -d postgres`), start from an empty database:

```sh
export DATABASE_URL=postgres://relay:relay_local@localhost:55432/relay_bench
export MASTER_KEY=$(openssl rand -hex 32)
export DEMO_ORIGIN=http://127.0.0.1:4100   # the benchmark sink
export RATE_LIMIT_PER_MINUTE=10000 LOG_LEVEL=warn
docker compose exec postgres createdb -U relay relay_bench

export OPERATOR_KEY=$(npm run -s bootstrap | tail -1)
npm run start:api &
WORKER_CONCURRENCY=16 npm run start:worker &
WORKER_CONCURRENCY=16 BENCHMARK_OUTPUT=benchmark.json npm run benchmark
```

Optional settings: `BENCHMARK_EVENTS` (default 2000), `BENCHMARK_PUBLISHERS` (20), `BENCHMARK_PAYLOAD_BYTES` (1024), `BENCHMARK_SINK_PORT` (4100) and `BENCHMARK_SETTLE_TIMEOUT_MS` (120000). `WORKER_CONCURRENCY` is only reported by the benchmark; set it on the worker process itself. `DEMO_ORIGIN` allows the plain-HTTP local sink and is rejected when `NODE_ENV=production`.
