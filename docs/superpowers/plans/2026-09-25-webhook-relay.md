# Webhook Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the self-hosted webhook platform described in the approved specification, with reproducible failure tests and public release tooling.

**Architecture:** A modular TypeScript codebase with separate API and worker entry points. Domain policy has no HTTP or database dependencies; application operations use explicit PostgreSQL transactions, and the HTTP transport enforces outbound network policy. PostgreSQL stores both business records and durable delivery work.

**Tech Stack:** Node.js 24 LTS, TypeScript strict mode, Fastify, node-postgres, Vitest with V8 coverage, PostgreSQL 18, OpenTelemetry, Docker Compose, GitHub Actions and GHCR. Pin resolved dependency versions in the lockfile after checking official documentation and security advisories during setup.

**Spec:** `docs/superpowers/specs/2026-09-25-webhook-relay-design.md`

## Global constraints

- Publish the source code under the Apache-2.0 license. No author-hosted production instance is required.
- Development, testing, CI, image publishing, and the local demo must require no paid service, credit card, commercial API, or cloud account.
- Use English for documentation, comments, commits, Issues, pull requests, and Project cards. Teaching explanations in the conversation may be in Portuguese. Do not add `Co-authored-by` trailers.
- Default request timeout: 5 seconds. Default maximum: 5 total attempts.
- Limit event JSON to 64 KiB and captured destination response text to a sanitized 2 KiB excerpt.
- CI requires at least 85% line coverage and 80% branch coverage across maintained TypeScript code, excluding generated code, migrations, and fixtures.
- Version 1 has no dashboard, .NET service, external message broker, paid integration, or ordering guarantee.
- Before the first push, consolidate the unpublished documentation-only history into a first commit titled `Set up project foundation`. That commit must contain a working setup, the approved specification and a structured English `README.md`. Preserve useful design content; exclude temporary artifacts, generated reports and credentials.

## Review focus

1. DNS answers can change between validation and connection; pin the validated address and retain the hostname for TLS verification. Task 2 tests this behavior.
2. Concurrent requests can reuse an idempotency key with different content; one succeeds and the other receives a conflict without partial fan-out. Task 3 tests this behavior.
3. A stale worker can finish after its lease expires; its result must not overwrite a newer owner. Task 5 tests this behavior.
4. A valid object ID from another project must reveal no data and allow no replay. Task 4 tests this behavior.
5. A tagged commit can differ from a previously checked branch commit; the release workflow must verify the tagged revision itself. Task 8 tests the release path.

## File and dependency boundaries

- `packages/core/src/`: errors, JSON normalization, retry policy, key hashing, secret encryption, signature generation and verification.
- `packages/db/src/`: pool configuration, migration runner, transaction helper and repositories grouped by domain capability.
- `apps/api/src/`: Fastify application factory, authentication, validation schemas and route modules.
- `apps/worker/src/`: claim loop, bounded execution, secure HTTP delivery and graceful shutdown.
- `apps/demo-receiver/src/`: local signed request receiver and deterministic failure scenarios.
- `tests/integration/`, `tests/e2e/`: real PostgreSQL concurrency and process-level recovery tests.
- `scripts/`: bootstrap, demo, clean-install smoke test and benchmark clients.
- `docs/adr/`, `docs/security.md`, `docs/operations.md`: design rationale, trust boundaries and operational procedures.
- `deploy/compose/`, `compose.yaml`, `Dockerfile`, `.github/workflows/`: local execution and release distribution.

Use composition and constructor/function injection for clocks, randomness, database access and transport. Avoid a dependency injection framework, generic base repositories or abstractions with only speculative consumers. SQL remains visible where locks, constraints and transaction boundaries matter.

## Task 1: Executable foundation and database lifecycle

**Files:** `README.md`, `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`, `.env.example`, `packages/core/src/config.ts`, `packages/db/src/pool.ts`, `packages/db/src/migrate.ts`, `packages/db/migrations/001_initial.sql`, `compose.yaml`, `tests/config.test.ts`, `tests/integration/migrations.test.ts`.

**Interfaces:** `readConfig(env: NodeJS.ProcessEnv): Config`; `createPool(databaseUrl: string): Pool`; `migrate(pool: Pool): Promise<void>`; `withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T>`.

- [ ] Write configuration tests that reject missing master keys, invalid positive limits and an unsafe production demo setting; write migration tests for clean install and repeated application.

```ts
expect(() => readConfig({ NODE_ENV: 'production' })).toThrow();
await migrate(pool);
await migrate(pool);
expect(await appliedMigrationCount(pool)).toBe(1);
```

- [ ] Run `npm test -- tests/config.test.ts tests/integration/migrations.test.ts`; observe failures caused by missing behavior.
- [ ] Add strict TypeScript scripts (`lint`, `typecheck`, `build`, `test`, `test:coverage`), configuration validation, a bounded database pool and transactional migrations with a PostgreSQL advisory lock. Use database constraints and composite project foreign keys. Add the PostgreSQL test service and a non-production example environment with no committed secret values.

```sql
CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] Run lint, typecheck and migration tests against real PostgreSQL. Confirm a failed migration rolls back and changed migration checksums fail safely.
- [ ] Write the initial English README with purpose, development status, architecture, prerequisites, setup commands, test commands, repository layout and license. Clearly distinguish implemented behavior from the planned delivery engine.
- [ ] After verification, preserve a local recovery reference and consolidate the unpushed documentation commits with this setup. Verify the root commit subject is `Set up project foundation` and its tree includes the setup and README. This is the first commit to publish; subsequent tasks receive separate coherent commits.

## Task 2: Security primitives and outbound transport

**Files:** `packages/core/src/credentials.ts`, `packages/core/src/signatures.ts`, `packages/core/src/secrets.ts`, `apps/worker/src/destination-policy.ts`, `apps/worker/src/http-transport.ts`, `tests/security.test.ts`, `tests/destination-policy.test.ts`, `tests/http-transport.test.ts`.

**Interfaces:** `issueKey(): { token: string; hash: string }`; `hashKey(token: string): string`; `encryptSecret(secret: string, masterKey: Buffer): string`; `decryptSecret(ciphertext: string, masterKey: Buffer): string`; `sign(body: Buffer, timestamp: number, secret: string): string`; `verify(body: Buffer, timestamp: number, signature: string, secret: string, now: number): boolean`; `resolveDestination(url: string, resolver: Resolver, policy: DestinationPolicy): Promise<PinnedDestination>`; `sendWebhook(input: SendInput): Promise<AttemptOutcome>`.

- [ ] Test altered signatures, expired timestamps, malformed encodings, ciphertext tampering, IPv4-mapped IPv6, mixed public/private DNS answers, URL credentials, non-HTTPS schemes, redirects, DNS changes, oversized responses and total timeout.

```ts
expect(verify(body, timestamp, signature, secret, timestamp + 301)).toBe(false);
expect(() => decryptSecret(tamperedCiphertext, masterKey)).toThrow();
await expect(resolveDestination('https://example.test', privateResolver, policy))
  .rejects.toThrow();
expect(connectionOptions.lookup).toBe(pinnedLookup);
expect(connectionOptions.servername).toBe('example.test');
```

- [ ] Run `npm test -- tests/security.test.ts tests/destination-policy.test.ts tests/http-transport.test.ts` and inspect the expected failures.
- [ ] Implement random 256-bit API tokens hashed with SHA-256, AES-256-GCM with fresh nonces, constant-time HMAC checks, a five-minute receiver timestamp window, IP range classification using a maintained library, validated IP pinning with hostname TLS verification, no redirects, streamed response limits and a timeout covering DNS through response processing. Reject all DNS answers if any is non-public. Restrict the local exception to the exact configured demo origin and development mode.

```ts
const signature = createHmac('sha256', secret)
  .update(String(timestamp)).update('.').update(body).digest('hex');
```

- [ ] Re-run tests and inspect request logging for secret or payload exposure.
- [ ] Commit: `Secure webhook credentials and outbound connections`.

## Task 3: Transactional event ingestion and idempotency

**Files:** `packages/core/src/events.ts`, `packages/db/src/projects.ts`, `packages/db/src/keys.ts`, `packages/db/src/endpoints.ts`, `packages/db/src/events.ts`, `tests/events.test.ts`, `tests/integration/ingestion.test.ts`.

**Interfaces:** `publishEvent(client: PoolClient, projectId: string, key: string, input: EventInput): Promise<PublishedEvent>`; `createProject(client: PoolClient, name: string): Promise<Project>`; `createProjectKey(client: PoolClient, projectId: string, permission: 'publish' | 'manage'): Promise<IssuedKey>`; `createEndpoint(client: PoolClient, projectId: string, input: EndpointInput): Promise<CreatedEndpoint>`.

- [ ] Test recursive JSON key canonicalization, distinct event types, matching endpoint fan-out, rollback after partial work and concurrent matching/conflicting idempotent requests.

```ts
const results = await Promise.all(Array.from({ length: 20 }, () => publish(input)));
expect(new Set(results.map(result => result.eventId)).size).toBe(1);
expect(await deliveryCountForEvent(pool, results[0].eventId)).toBe(2);
await expect(publish({ ...input, data: { changed: true } })).rejects.toMatchObject({ status: 409 });
```

- [ ] Run `npm test -- tests/events.test.ts tests/integration/ingestion.test.ts`; confirm the tests fail before implementation.
- [ ] Implement a unique `(project_id, idempotency_key)` constraint, canonical content digest, conflict-safe insertion and event/delivery fan-out in one transaction. Persist the exact outbound envelope bytes so signing and retry use identical content. A repeat retains the original destination snapshot and does not create new deliveries.

```sql
INSERT INTO events (id, project_id, idempotency_key, content_hash, body)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (project_id, idempotency_key) DO NOTHING;
```

- [ ] Verify concurrent matching and conflicting submissions, transaction rollback and project isolation against PostgreSQL.
- [ ] Commit: `Add transactional event ingestion and idempotent fan-out`.

## Task 4: Authenticated API and public contract

**Files:** `apps/api/src/app.ts`, `apps/api/src/auth.ts`, `apps/api/src/schemas.ts`, `apps/api/src/routes/{projects,endpoints,events,deliveries}.ts`, `apps/api/src/main.ts`, `scripts/bootstrap.ts`, `tests/integration/api.test.ts`, `docs/openapi.json`.

**Interfaces:** `buildApp(deps: { pool: Pool; config: Config }): Promise<FastifyInstance>`; `authenticate(token: string): Promise<Principal>` with operator or project-scoped permissions; `replayDelivery(client: PoolClient, projectId: string, deliveryId: string, actorKeyId: string): Promise<ReplayResult>`.

- [ ] Test every specified route with valid/missing credentials, wrong permission, cross-project IDs, malformed UUIDs, oversized bodies, unsupported fields, limited pagination and rate limits. Cover replay of active and terminal deliveries.

```ts
const response = await app.inject({ method: 'GET', url: `/v1/events/${otherProjectEventId}`, headers: manageHeaders });
expect(response.statusCode).toBe(404);
expect((await app.inject({ method: 'POST', url: '/v1/events', headers: publishHeaders, payload: validEvent })).statusCode).toBe(202);
```

- [ ] Run `npm test -- tests/integration/api.test.ts` against a clean database and inspect failures.
- [ ] Implement schema-validated routes, response schemas that never serialize secrets, project-scoped queries and a bootstrap command that outputs the initial token only once. Rate limits are installation-wide per project using atomic PostgreSQL counters with bounded retention, not independent per-process allowances. Redact authentication headers, destination credentials and request bodies from logs. Generate OpenAPI from route schemas.

```ts
return reply.code(202).send({ eventId: event.id, deliveryIds: event.deliveryIds });
```

- [ ] Verify validation failures do not execute domain writes; generate OpenAPI and run route tests.
- [ ] Commit: `Expose project-scoped webhook APIs and OpenAPI documentation`.

## Task 5: Concurrent delivery engine and recovery

**Files:** `packages/core/src/retry-policy.ts`, `packages/db/src/deliveries.ts`, `apps/worker/src/runner.ts`, `apps/worker/src/main.ts`, `tests/retry-policy.test.ts`, `tests/integration/worker.test.ts`, `tests/e2e/recovery.test.ts`.

**Interfaces:** `classifyOutcome(outcome: AttemptOutcome): 'success' | 'retry' | 'failed'`; `retryDelay(attempt: number, random: () => number): number`; `claimDeliveries(pool: Pool, limit: number, leaseMs: number): Promise<ClaimedDelivery[]>`; `finishAttempt(pool: Pool, claim: ClaimedDelivery, outcome: AttemptOutcome): Promise<boolean>`; `runBatch(deps: WorkerDependencies): Promise<number>`.

- [ ] Test all status classes, deterministic jitter, five-attempt exhaustion, bounded concurrency, lease expiry, stale completion, replay cycles and forced worker termination after the receiver responds.

```ts
const [left, right] = await Promise.all([claimDeliveries(pool, 10, leaseMs), claimDeliveries(pool, 10, leaseMs)]);
expect(new Set([...left, ...right].map(x => x.id)).size).toBe(left.length + right.length);
expect(await finishAttempt(pool, expiredClaim, successOutcome)).toBe(false);
```

- [ ] Run policy/integration/recovery tests and confirm missing worker behavior produces failures.
- [ ] Implement short claim transactions, database time for lease ownership and due work, indexed queue queries, claim-time immutable attempt records, compare-and-set completion and abandoned-attempt recovery. Count interrupted attempts toward the limit. Use bounded async I/O, not worker threads, for HTTP requests. Handle SIGTERM by stopping claims and draining in-flight work within a deadline shorter than the lease. Replay keeps the stable event and delivery IDs, increments the cycle and audits the requesting key.

```sql
UPDATE deliveries SET state = $1, lease_token = NULL, lease_until = NULL
WHERE id = $2 AND lease_token = $3 AND lease_until > now();
```

- [ ] Verify the process-level crash test can observe duplicate receipt, preserves the event and prevents a stale worker from changing current ownership. Inspect `EXPLAIN` for the due-work query under the benchmark dataset.
- [ ] Commit: `Implement leased deliveries and bounded crash recovery`.

## Task 6: Observability, retention and local demo

**Files:** `packages/core/src/telemetry.ts`, `packages/db/src/retention.ts`, `apps/worker/src/health.ts`, `apps/demo-receiver/src/main.ts`, `scripts/demo.ts`, `tests/integration/retention.test.ts`, `tests/e2e/demo.test.ts`, `docs/operations.md`.

**Interfaces:** `cleanupExpired(pool: Pool, retentionDays: number, batchSize: number): Promise<number>`; `startTelemetry(config: TelemetryConfig): Promise<Shutdown>`; `/health/live` and `/health/ready` endpoints.

- [ ] Test that expired terminal records are removed, active deliveries survive cleanup, readiness fails during database outage, and demo success/failure/replay scenarios assert outcomes rather than sleep for fixed durations.

```ts
await cleanupExpired(pool, 30, 100);
expect(await exists(activeDelivery)).toBe(true);
expect(await exists(expiredTerminalEvent)).toBe(false);
expect(demoResult.successfulDeliveries).toBe(1);
```

- [ ] Run these tests and inspect expected failures.
- [ ] Add bounded cleanup transactions, liveness/readiness, structured event and attempt IDs, request/delivery traces and metrics for latency, queue age, attempt outcome and worker activity. Avoid project IDs as metric labels and avoid sensitive payloads in telemetry. Provide an optional local OpenTelemetry collector profile; no external telemetry endpoint is required. Demo endpoints fail a configured number of times or time out, and verify HMAC and timestamp before accepting an event.

```ts
attemptCounter.add(1, { outcome: result.kind });
deliverySpan.setAttribute('webhook.delivery.id', claim.id);
```

- [ ] Run the full local demo and inspect one request-to-attempt trace and a failed-then-successful delivery history.
- [ ] Commit: `Add operational telemetry and reproducible failure demos`.

## Task 7: Documentation, benchmark and coverage gates

**Files:** `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/security.md`, `docs/adr/0001-postgresql-queue.md`, `docs/adr/0002-at-least-once.md`, `scripts/benchmark.ts`, `docs/benchmarks.md`, `vitest.config.ts`, `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`.

- [ ] Add benchmark assertions that fail on missing/incorrect completion accounting and a documentation smoke test that runs the quickstart requests against the real API.

```ts
expect(report.accepted).toBe(report.delivered + report.failed + report.pending);
expect(report.environment.nodeVersion).toMatch(/^v24\./);
```

- [ ] Run the new tests and confirm failures before adding benchmark reporting and quickstart steps.
- [ ] Record measured throughput, p50/p95/p99, completion latency, queue lag, errors, CPU/memory configuration, payload size, concurrency and duration. Distinguish API acceptance from successful delivery. Write English docs for bootstrap, demo, verification, backup/master-key recovery, upgrades, security limitations, architecture and troubleshooting. Add the actual Apache-2.0 license text. Configure coverage to include all maintained application/package TypeScript, including files not imported by tests; do not exclude difficult adapters or entry points to meet the gate.

```ts
coverage: { provider: 'v8', include: ['apps/**/*.ts', 'packages/**/*.ts'],
  thresholds: { lines: 85, branches: 80 } }
```

- [ ] Run `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage`, the clean-database demo and benchmark. Record real results and investigate any unmet coverage or correctness gate.
- [ ] Commit: `Document operation and publish reproducible reliability evidence`.

## Task 8: Container distribution and release verification

**Files:** `Dockerfile`, `.dockerignore`, `compose.yaml`, `deploy/compose/compose.release.yaml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/dependabot.yml`, `scripts/smoke-release.ts`.

- [ ] Add an image smoke test that starts PostgreSQL, runs migrations/bootstrap and verifies signed event delivery using the built API and worker images.

```ts
expect(await health(apiUrl)).toBe('ready');
expect(await publishAndWait(apiUrl, fixture)).toMatchObject({ state: 'succeeded' });
```

- [ ] Build images and run the smoke test before release wiring; inspect failures for missing runtime files or dependencies.
- [ ] Use multi-stage non-root images, runtime-only dependencies, Docker secrets/file-based key support, health checks and explicit shutdown periods. Default Compose supports the documented demo; release Compose pulls versioned public images and uses persistent database storage. Pin third-party Actions to verified commit SHAs and minimize token permissions. Pull requests get read-only permissions and no publishing credentials. The tag workflow reruns required validation and the image smoke test against the checked-out tag before publishing API/worker images and image digests. Publish multi-platform images only after both target architectures pass smoke testing; otherwise explicitly release Linux amd64 first and document it.

```yaml
permissions:
  contents: read
# Grant packages: write only to the image publishing job.
```

- [ ] Validate workflow syntax, verify publication gates on the tagged revision and install from built release artifacts. Create the public GitHub repository and connect it only after checking the active identity is exactly `LuizPassos97`. Run remote CI and fix any platform-specific failures before declaring the release ready. Confirm GHCR visibility and anonymous pull behavior on first publication.
- [ ] Commit: `Automate verified container releases to GHCR`.

## Completion evidence and handoff

- [ ] A fresh checkout follows the README without private packages, paid services or untracked setup.
- [ ] Tests and coverage satisfy the spec; concurrent ingestion, stale leases, DNS pinning and crash recovery have explicit evidence.
- [ ] CI passes for the final revision. Do not describe unrun container or remote checks as passing.
- [ ] Git history uses English subjects and contains no coauthor trailers; all documentation and repository comments are in English.
- [ ] Review the whole branch for security, reliability, spec completeness and documentation accuracy, resolve actionable findings and rerun affected tests.
- [ ] Summarize actual results, remaining limits and the next .NET extension in Portuguese for the user.

## Environment observation

Node.js v24.12.0 and npm 11.6.2 are available. Docker CLI 29.1.2 is installed, but its daemon was unavailable during planning. A running compatible container engine is needed for PostgreSQL integration tests and image smoke tests. This is a verification prerequisite, not a reason to replace those tests with mocks.
