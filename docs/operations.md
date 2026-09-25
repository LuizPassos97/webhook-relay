# Operations

This guide covers running Webhook Relay locally or on your own server: container installation, processes, configuration, health checks, telemetry, data retention, backups, upgrades and the failure demo.

## Processes

| Process       | Command                       | Purpose                                                                    |
| ------------- | ----------------------------- | -------------------------------------------------------------------------- |
| API           | `npm run start:api`           | HTTP API on `PORT` (default 3000)                                          |
| Worker        | `npm run start:worker`        | Claims and sends deliveries; health server on `WORKER_PORT` (default 3001) |
| Demo receiver | `npm run start:demo-receiver` | Sample consumer for the local demo only                                    |

Run database migrations before starting new versions: `npm run migrate` (or `npm run bootstrap` on a new installation, which also prints the operator key once). You can run several API and worker processes against the same database; the queue, rate limits and retention are coordinated through PostgreSQL.

Both the API and the worker stop cleanly on `SIGTERM`: the API finishes in-flight requests, and the worker stops claiming and waits for in-flight deliveries within 75% of the lease duration.

## Container installation

Each release publishes two images for `linux/amd64` and `linux/arm64`, built from the same Dockerfile: `ghcr.io/luizpassos97/webhook-relay-api` and `ghcr.io/luizpassos97/webhook-relay-worker`. Both run as the unprivileged `node` user, contain only runtime dependencies and define health checks. The [GitHub release](https://github.com/LuizPassos97/webhook-relay/releases) lists the image digests.

[`deploy/compose/compose.release.yaml`](../deploy/compose/compose.release.yaml) installs a release with persistent PostgreSQL storage and file-based secrets:

```sh
VERSION=0.1.0
mkdir -p webhook-relay/secrets && cd webhook-relay
curl -fsSLO "https://raw.githubusercontent.com/LuizPassos97/webhook-relay/v$VERSION/deploy/compose/compose.release.yaml"

# Secrets: the directory stays private; the files must be readable by the container user.
chmod 700 secrets
openssl rand -hex 24 > secrets/postgres_password
printf 'postgres://relay:%s@postgres:5432/relay' "$(cat secrets/postgres_password)" > secrets/database_url
openssl rand -hex 32 > secrets/master_key
chmod 444 secrets/*

export WEBHOOK_RELAY_VERSION=$VERSION
docker compose -f compose.release.yaml up -d --wait
docker compose -f compose.release.yaml run --rm api node dist/scripts/bootstrap.js   # operator key, once
```

The API listens on `127.0.0.1:3000`; put a TLS-terminating reverse proxy in front of it (set `API_BIND_ADDRESS` and `API_PORT` to change the binding). Migrations run automatically in the `migrate` service before the API and worker start. To upgrade, back up the database, change `WEBHOOK_RELAY_VERSION` and run `up -d --wait` again.

Scale workers with `docker compose -f compose.release.yaml up -d --scale worker=3`. Other settings from the configuration table can be added to the `environment` of the `api` and `worker` services.

## Configuration

| Variable                      | Default     | Notes                                                                                       |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | required    | PostgreSQL URL. `DATABASE_URL_FILE` reads it from a file.                                   |
| `MASTER_KEY`                  | required    | 32 bytes as hex; encrypts endpoint signing secrets. `MASTER_KEY_FILE` reads it from a file. |
| `NODE_ENV`                    | —           | `production` forbids the demo origin and retry scaling.                                     |
| `PORT` / `WORKER_PORT`        | 3000 / 3001 | API port and worker health port.                                                            |
| `WORKER_CONCURRENCY`          | 4           | Maximum requests in flight per worker (1–64).                                               |
| `DELIVERY_TIMEOUT_MS`         | 5000        | Deadline for one attempt, from DNS to response.                                             |
| `LEASE_MS`                    | 30000       | Lease per claimed delivery; at least twice the timeout.                                     |
| `WORKER_POLL_MS`              | 1000        | Idle wait between queue checks.                                                             |
| `RATE_LIMIT_PER_MINUTE`       | 120         | Requests per project key per minute, shared by all API processes.                           |
| `RETENTION_DAYS`              | 30          | Age after which finished events are deleted.                                                |
| `RETRY_SCALE`                 | 1           | Multiplies retry delays; below 1 only for demos and tests.                                  |
| `DEMO_ORIGIN`                 | —           | Development only: the single `http://` origin allowed as a destination.                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | —           | Enables OpenTelemetry export (OTLP over HTTP).                                              |

Keep the master key backed up separately from database backups. Without it, stored endpoint secrets cannot be decrypted and every delivery fails.

## Health checks

| Endpoint            | API       | Worker    | Meaning                                                                                                  |
| ------------------- | --------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | port 3000 | port 3001 | The process responds. Use for restarts.                                                                  |
| `GET /health/ready` | port 3000 | port 3001 | The database answers (and, for the worker, it is not shutting down). Use for traffic routing and alerts. |

Readiness returns `503` during a database outage, while liveness stays `200` so the orchestrator does not restart processes that will recover by themselves.

## Telemetry

Telemetry is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. No external service is required: the Compose file has an optional local collector that prints everything to its log.

```sh
docker compose --profile observability up -d otel-collector
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
docker compose logs -f otel-collector
```

**Traces.** Each API request creates a span named after its route template (for example `POST /v1/events`). The request's trace context is stored with the event, so every delivery attempt (`webhook.deliver`) appears in the same trace, including retries and replays hours later. Attempt spans carry `webhook.delivery.id`, `webhook.event.id`, `webhook.attempt.cycle`, `webhook.attempt.number`, `webhook.attempt.outcome` and `http.response.status_code`. An incoming `traceparent` header continues the caller's trace.

**Metrics.**

| Metric                              | Type            | Attributes                          |
| ----------------------------------- | --------------- | ----------------------------------- |
| `webhook.api.request.duration`      | histogram (ms)  | method, route template, status code |
| `webhook.delivery.attempts`         | counter         | outcome, resulting state            |
| `webhook.delivery.attempt.duration` | histogram (ms)  | outcome                             |
| `webhook.worker.in_flight`          | up/down counter | —                                   |
| `webhook.queue.age`                 | gauge (s)       | —                                   |

`webhook.queue.age` is the age of the oldest due delivery that no worker has claimed. If it keeps growing, workers cannot keep up: add workers or raise `WORKER_CONCURRENCY`.

Telemetry never contains event payloads, secrets, API keys or project IDs. Metric attributes use small fixed value sets so the number of time series stays bounded.

## Data retention

Every worker deletes events older than `RETENTION_DAYS` once per hour, together with their deliveries, attempts and replay audit records. Events that still have a pending or in-flight delivery are kept until it finishes. Deletion runs in batches of 500 events per transaction, so it never blocks the delivery queue for long.

## Backups and master key

Back up two things, separately:

1. **The database**, with regular PostgreSQL tools (`pg_dump` for small installations, or base backups with WAL archiving for point-in-time recovery). It holds events, deliveries, attempt history, hashed API keys and encrypted endpoint secrets.
2. **The master key** (`MASTER_KEY` or the file behind `MASTER_KEY_FILE`), for example in a password manager or secret store. Never store it next to the database backup: together they reveal every endpoint secret.

To restore, recreate the database from the backup, start the API and worker with the **same** master key, and run `npm run migrate` if the restored backup is older than the application version.

If the master key is lost, stored endpoint secrets cannot be decrypted and deliveries to existing endpoints fail with `Delivery attempt failed unexpectedly`. Recovery: start with a new master key, recreate each endpoint through the API (which issues a new signing secret), and give the new secrets to the consumers. Events, attempt history and API keys are unaffected.

## Upgrades

1. Read the [changelog](../CHANGELOG.md) for breaking changes and new settings.
2. Back up the database.
3. Apply migrations with the new version: `npm run migrate`. Migrations run in one transaction under an advisory lock, so a failure leaves the schema unchanged, and concurrent runs apply each migration once. A migration file edited after release is rejected by checksum.
4. Restart API and worker processes. Workers finish in-flight deliveries on `SIGTERM`; deliveries interrupted by a forced stop are recovered when their lease expires.

Migrations only add backward-compatible changes within a minor version, so old and new processes can run side by side during a rolling restart.

## Failure demo

The demo shows a successful delivery, retries after errors and a timeout, an exhaustion that succeeds after a replay, and a consumer rejecting a tampered request.

**With Docker only** (builds the images locally; no Node.js needed):

```sh
docker compose up -d --build --wait
OPERATOR_KEY=$(docker compose run --rm api node dist/scripts/bootstrap.js | tail -1)
docker compose run --rm -e OPERATOR_KEY="$OPERATOR_KEY" \
  -e API_URL=http://api:3000 -e DEMO_RECEIVER_URL=http://demo-receiver:4000 \
  api node dist/scripts/demo.js
docker compose down --volumes   # when finished
```

The default `compose.yaml` uses development settings (a plain-HTTP demo receiver and short retries), generates its own master key in a volume, and is not meant for production.

**With Node.js**, running the processes directly (PostgreSQL from `docker compose up -d postgres`):

```sh
export DATABASE_URL=postgres://relay:relay_local@localhost:55432/relay
export MASTER_KEY=$(openssl rand -hex 32)
export DEMO_ORIGIN=http://localhost:4000
# Short retries and timeouts so the demo finishes in about 20 seconds.
export RETRY_SCALE=0.001 DELIVERY_TIMEOUT_MS=1000 LEASE_MS=5000

npm run bootstrap                  # prints the operator key once
npm run start:demo-receiver &
npm run start:api &
npm run start:worker &
OPERATOR_KEY=<printed key> npm run demo
```

Expected output:

```text
healthy consumer         succeeded  cycle 1  attempts: 200
fails twice              succeeded  cycle 1  attempts: 503, 503, 200
times out once           succeeded  cycle 1  attempts: timeout, 200
always fails             failed     cycle 1  attempts: 503, 503, 503, 503, 503
after fix and replay     succeeded  cycle 2  attempts: 503, 503, 503, 503, 503, 200
altered body rejected by consumer with HTTP 401
```

The command exits with status 1 if any scenario behaves differently. Set `OTEL_EXPORTER_OTLP_ENDPOINT` as shown above to see each scenario as one trace from the publishing request to its last attempt.

## Troubleshooting

| Symptom                                            | Likely cause                                                                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every attempt fails with outcome `rejected`        | The endpoint URL resolves to a private or reserved address, or is not HTTPS. In development, check that `DEMO_ORIGIN` matches the endpoint origin exactly. |
| Attempts fail with outcome `network`               | DNS failure, connection refused or TLS error at the destination. These are retried.                                                                        |
| Deliveries stay `processing`                       | The worker died; they are recovered automatically once `LEASE_MS` expires, and the interrupted attempt is recorded as `abandoned`.                         |
| `429` from the API                                 | The project exceeded `RATE_LIMIT_PER_MINUTE`; wait for the `Retry-After` seconds.                                                                          |
| Worker logs `Delivery attempt failed unexpectedly` | Often a different `MASTER_KEY` than the one used to create the endpoint.                                                                                   |
