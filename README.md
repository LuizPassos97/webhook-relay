# Webhook Relay

Self-hosted webhook delivery with a durable PostgreSQL queue, signed requests, retries, replay and explicit at-least-once semantics.

Your application publishes an event once; Webhook Relay stores it, fans it out to every subscribed endpoint, signs each request with HMAC-SHA256, retries transient failures with backoff and keeps a full attempt history you can inspect and replay.

<p align="center">
  <img src="docs/assets/demo.gif" width="900" alt="The failure demo: a healthy consumer succeeds, a flaky one succeeds on the third attempt, a slow one after a timeout, a broken one fails after five attempts and succeeds after a replay, and a tampered request is rejected with HTTP 401.">
</p>

<p align="center"><sub>Output of the <a href="docs/operations.md#failure-demo">failure demo</a> from a real run; the waiting time is shortened.</sub></p>

## Status

Version 0.1 is feature-complete for the scope in the [design specification](docs/superpowers/specs/2026-09-25-webhook-relay-design.md): project-scoped API, transactional idempotent ingestion, leased delivery workers with crash recovery, outbound network protection, OpenTelemetry, retention, a local failure demo and verified multi-platform container images.

## Architecture

```mermaid
flowchart LR
  publisher[Your application] -->|POST /v1/events| api[API]
  api -->|event + deliveries<br/>one transaction| db[(PostgreSQL)]
  worker[Worker] -->|claim with lease<br/>SKIP LOCKED| db
  worker -->|signed POST| consumer[Consumer endpoint]
  worker -->|record attempt<br/>if lease still owned| db
```

- The **API** authenticates the caller, validates the event and stores it with one delivery per subscribed endpoint in a single transaction before answering `202`.
- **Workers** claim due deliveries with `FOR UPDATE SKIP LOCKED` and a time-limited lease, send the request outside any transaction, and record the result only if they still own the lease.
- **PostgreSQL** is both the system of record and the queue; there is no separate broker. See [ADR 0001](docs/adr/0001-postgresql-queue.md).

## Install

Released versions are published as container images for `linux/amd64` and `linux/arm64`. Follow [Container installation](docs/operations.md#container-installation) to run a release with Docker Compose, persistent storage and file-based secrets.

To see retries, timeouts, replay and signature checks without writing any code, run the [failure demo](docs/operations.md#failure-demo); it only needs Docker.

## Quickstart

To run from source instead. Requirements: Node.js 24 LTS, npm, Docker (or another free container runtime), `curl` and `jq`.

```sh
npm ci
docker compose up -d postgres
export DATABASE_URL=postgres://relay:relay_local@localhost:55432/relay
export MASTER_KEY=$(openssl rand -hex 32)   # keep it: it encrypts endpoint secrets
npm run bootstrap                           # applies migrations, prints the operator key once
npm run start:api                           # port 3000; run the worker in another terminal
npm run start:worker                        # with the same environment variables
```

Then publish your first event. `WEBHOOK_URL` must be a public HTTPS URL you control (for example a request inspector); private and local addresses are rejected. For a fully local run, use the [failure demo](docs/operations.md#failure-demo) instead.

<!-- quickstart:start -->

```bash
API_URL=${API_URL:-http://localhost:3000}
auth() { printf 'Authorization: Bearer %s' "$1"; }

# 1. Create a project and its keys (operator key).
PROJECT_ID=$(curl -sf -X POST "$API_URL/v1/projects" -H "$(auth "$OPERATOR_KEY")" \
  -H 'Content-Type: application/json' -d '{"name":"Quickstart"}' | jq -r .id)
MANAGE_KEY=$(curl -sf -X POST "$API_URL/v1/projects/$PROJECT_ID/keys" -H "$(auth "$OPERATOR_KEY")" \
  -H 'Content-Type: application/json' -d '{"permission":"manage"}' | jq -r .token)
PUBLISH_KEY=$(curl -sf -X POST "$API_URL/v1/projects/$PROJECT_ID/keys" -H "$(auth "$OPERATOR_KEY")" \
  -H 'Content-Type: application/json' -d '{"permission":"publish"}' | jq -r .token)

# 2. Register an endpoint. The signing secret is shown only in this response.
curl -sf -X POST "$API_URL/v1/endpoints" -H "$(auth "$MANAGE_KEY")" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"$WEBHOOK_URL\",\"eventTypes\":[\"order.created\"]}" | jq '{id, secret}'

# 3. Publish an event. Repeating the request with the same Idempotency-Key is safe.
DELIVERY_ID=$(curl -sf -X POST "$API_URL/v1/events" -H "$(auth "$PUBLISH_KEY")" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: order-1001' \
  -d '{"type":"order.created","data":{"orderId":1001,"total":49.9}}' | jq -r '.deliveryIds[0]')

# 4. Follow the delivery until the worker has recorded the attempt.
for _ in $(seq 1 20); do
  STATE=$(curl -sf "$API_URL/v1/deliveries/$DELIVERY_ID" -H "$(auth "$MANAGE_KEY")" | jq -r .state)
  [ "$STATE" = pending ] || [ "$STATE" = processing ] || break
  sleep 1
done
echo
curl -sf "$API_URL/v1/deliveries/$DELIVERY_ID" -H "$(auth "$MANAGE_KEY")" |
  jq '{state, attempts: [.attempts[] | {number, statusCode}]}'
```

<!-- quickstart:end -->

The test suite runs this block against a real API and worker (`tests/e2e/quickstart.test.ts`), so it stays in sync with the code.

## Receiving webhooks

Each request is a `POST` with a JSON body `{"id", "type", "createdAt", "data"}` and these headers:

| Header                  | Meaning                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `X-Webhook-Id`          | Event ID; identical on every retry and replay                |
| `X-Webhook-Delivery-Id` | Delivery ID (one per endpoint)                               |
| `X-Webhook-Timestamp`   | Unix seconds when this attempt was signed                    |
| `X-Webhook-Signature`   | Hex HMAC-SHA256 of `<timestamp>.<raw body>` with your secret |

Verify the signature over the **raw** body before parsing it, reject timestamps older than five minutes, and deduplicate by event ID:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function isAuthentic(rawBody, headers, secret, now = Date.now() / 1000) {
  const timestamp = Number(headers['x-webhook-timestamp']);
  const signature = String(headers['x-webhook-signature'] ?? '');
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > 300) return false;
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}

// After verifying: skip events you have already processed.
// if (await alreadyProcessed(headers['x-webhook-id'])) return respond(200);
```

Answer with any `2xx` quickly and do the work asynchronously. Retries use the same event ID and body bytes, so storing processed IDs (for longer than the retry window of about three hours) makes processing idempotent.

## Delivery guarantees

- **At least once, not exactly once.** A worker can crash after the consumer received a request but before the result was saved; another worker then sends it again. See [ADR 0002](docs/adr/0002-at-least-once.md).
- **Retries:** network errors, timeouts, `408`, `429` and `5xx` are retried after about 1, 5, 30 and 120 minutes (±20% jitter), for at most 5 attempts. Other `4xx` responses and redirects fail immediately.
- **Replay:** any finished delivery can be replayed through the API; it starts a new attempt cycle and keeps the earlier history.
- **No ordering** across events or endpoints.

## Documentation

- [Operations](docs/operations.md): configuration, health checks, telemetry, retention, backups, upgrades, the failure demo and troubleshooting.
- [Security](docs/security.md): threat model, trust boundaries and known limitations.
- [Benchmarks](docs/benchmarks.md): method and measured results.
- [OpenAPI](docs/openapi.json): the API contract, also served at `/openapi.json`.
- Architecture decisions: [PostgreSQL as the queue](docs/adr/0001-postgresql-queue.md), [at-least-once delivery](docs/adr/0002-at-least-once.md).

## Development

```sh
npm run lint            # ESLint with type-aware rules and Prettier formatting check
npm run typecheck
npm run build
npm test                # requires the Compose PostgreSQL on port 55432
npm run test:coverage   # fails below 85% lines or 80% branches
```

Integration tests create and drop their own temporary databases on the local PostgreSQL; set `TEST_DATABASE_URL` to use another server. Never point tests at an installation with real data. See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.

| Path                 | Contents                                                      |
| -------------------- | ------------------------------------------------------------- |
| `apps/api`           | Fastify API, authentication, routes and OpenAPI               |
| `apps/worker`        | Claim loop, HTTP transport, health server                     |
| `apps/demo-receiver` | Sample consumer for the local demo                            |
| `packages/core`      | Configuration, security primitives, retry policy, telemetry   |
| `packages/db`        | Migrations, transactions and queries                          |
| `scripts`            | Bootstrap, migrations, OpenAPI generation, demo and benchmark |
| `tests`              | Unit, integration (real PostgreSQL) and end-to-end tests      |

## Releases

Pushing a `vX.Y.Z` tag on `main` runs [the release workflow](.github/workflows/release.yml): it checks that the tag matches `package.json`, reruns every CI check on the tagged commit, builds the images natively on amd64 and arm64 runners, smoke tests those exact images with both Compose files, and only then publishes them to GHCR with their digests in the GitHub release. Multi-platform tags are created only after both architectures pass.

## Cost

Development, tests, CI, image publishing and the demo need no paid service, account or credit card. No hosted instance is provided: you run it on your own infrastructure.

## License

[Apache-2.0](LICENSE)
