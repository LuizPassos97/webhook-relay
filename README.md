# Webhook Relay

Open source webhook delivery with durable PostgreSQL queues, signed requests, and explicit at-least-once semantics.

## Development status

The foundation provides validated configuration, transactional database migrations, API key hashing, secret encryption, request signing, an outbound HTTP transport that blocks non-public destinations, transactional event ingestion with idempotent fan-out, an authenticated, project-scoped HTTP API, and a delivery worker with leases, retries and crash recovery. Observability, the local demo and container releases are under development; this revision is not a production release.

## Architecture

The API accepts events transactionally. A separate worker claims due deliveries using PostgreSQL leases. Consumers verify HMAC signatures and deduplicate stable event IDs. See the [approved specification](docs/superpowers/specs/2026-09-25-webhook-relay-design.md).

## Prerequisites

- Node.js 24 LTS and npm
- Docker Engine with Compose, or a compatible free container runtime

## Development setup

```sh
npm ci
docker compose up -d postgres
export DATABASE_URL=postgres://relay:relay_local@localhost:55432/relay
npm run bootstrap        # applies migrations and prints the operator API key once
export MASTER_KEY=$(openssl rand -hex 32)
npm run start:api        # HTTP API on port 3000
npm run start:worker     # delivery worker, in another terminal with the same variables
```

The Compose credentials are exclusively for a database bound to the local development host. Copy `.env.example` for reference; no real secrets belong in Git. Keep the master key: it encrypts endpoint signing secrets, and losing it makes existing endpoints unusable.

The API listens on port 3000 and serves its OpenAPI document at `/openapi.json` (also committed as [docs/openapi.json](docs/openapi.json); regenerate it with `npm run openapi`). All `/v1` routes expect `Authorization: Bearer <key>`:

- the operator key creates projects and project keys;
- a project `manage` key registers endpoints and reads events and deliveries;
- a project `publish` key publishes events with an `Idempotency-Key` header.

## Delivery guarantees

Delivery is **at least once**. Workers claim due deliveries with PostgreSQL `FOR UPDATE SKIP LOCKED` and a time-limited lease; only the current lease holder can record a result. If a worker dies after the receiver got the request but before the result was saved, the lease expires and another worker sends the same event again with the same `X-Webhook-Id` and `X-Webhook-Delivery-Id`, so receivers must deduplicate by event ID. Deliveries are not ordered.

Network errors, timeouts, `408`, `429` and `5xx` are retried after about 1, 5, 30 and 120 minutes (±20% jitter), for at most 5 attempts. Other `4xx` responses and redirects fail immediately. Interrupted attempts count toward the limit. A failed or succeeded delivery can be replayed through the API, which starts a new attempt cycle and keeps the earlier history.

Worker settings: `WORKER_CONCURRENCY` (default 4), `DELIVERY_TIMEOUT_MS` (default 5000), `LEASE_MS` (default 30000, at least twice the timeout) and `WORKER_POLL_MS` (default 1000). On `SIGTERM` the worker stops claiming and waits for in-flight requests before exiting.

## Verification

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run test:coverage
```

`npm run lint` runs ESLint with type-aware rules and checks formatting with Prettier. Run `npm run lint:fix` to apply automatic fixes and formatting.

Integration tests use a disposable local database at port 55432; set `TEST_DATABASE_URL` to override. Never point tests at an installation containing real data.

## Repository layout

- `apps/`: API, worker and demo receiver
- `packages/core/`: configuration and domain policy
- `packages/db/`: PostgreSQL transactions and migrations
- `tests/`: unit, integration and end-to-end tests
- `docs/`: specification, design decisions and operational guides

## Cost and distribution

Development and local execution require no paid service. Public container releases will be distributed through GHCR using standard GitHub Actions runners. No hosted production service is provided.

## License

[Apache-2.0](LICENSE).
