# Webhook Relay

Open source webhook delivery with durable PostgreSQL queues, signed requests, and explicit at-least-once semantics.

## Development status

The foundation provides validated configuration, transactional database migrations, API key hashing, secret encryption, request signing and an outbound HTTP transport that blocks non-public destinations. The delivery API and worker are under development; this revision is not a production release.

## Architecture

The API accepts events transactionally. A separate worker claims due deliveries using PostgreSQL leases. Consumers verify HMAC signatures and deduplicate stable event IDs. See the [approved specification](docs/superpowers/specs/2026-09-25-webhook-relay-design.md).

## Prerequisites

- Node.js 24 LTS and npm
- Docker Engine with Compose, or a compatible free container runtime

## Development setup

```sh
npm ci
docker compose up -d postgres
DATABASE_URL=postgres://relay:relay_local@localhost:55432/relay npm run migrate
```

The Compose credentials are exclusively for a database bound to the local development host. Copy `.env.example` for reference; no real secrets belong in Git. Generate a 32-byte hexadecimal master key before starting application services.

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
