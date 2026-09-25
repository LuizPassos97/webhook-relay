# Webhook Relay — design specification v0.3

- **Status:** approved for implementation planning
- **Goal:** an open source, self-hosted backend project that demonstrates advanced reliability engineering with Node.js and TypeScript.
- **Audience:** developers who need to publish HTTP events to consumers, and technical reviewers of the portfolio.
- **Local directory:** `/Users/luizhenriquepassos/Developer/Projetos/webhook-relay`
- **Planned GitHub repository:** `LuizPassos97/webhook-relay`

## 1. Principles and constraints

- Publish the source code under the Apache-2.0 license. No author-hosted production instance is required.
- Development, testing, CI, image publishing, and the local demo must require no paid service, credit card, commercial API, or cloud account.
- Keep required dependencies and tools free to use. Docker Engine/Compose or a compatible implementation must be sufficient; a paid Docker Desktop license must not be required.
- Use standard free GitHub Actions runners for a public repository and public images in GitHub Container Registry (GHCR). Recheck the services' pricing and policies before the first release and change the distribution approach before incurring any cost.
- Demonstrate advanced engineering through reproducible behavior: concurrent workers, idempotency under races, crash recovery, outbound URL security, resource limits, and observability. Document trade-offs in short architecture decision records (ADRs) and publish a benchmark with its environment and method.
- **Use English for every repository artifact and interaction:** commit subjects and bodies, source comments and docstrings, README and other documentation, API descriptions, Issues, pull requests, Project cards, and comments on those items. Teaching explanations in this Codex conversation may be in Portuguese. Do not add `Co-authored-by` trailers.

## 2. Expected outcome

A developer can clone the repository, start the platform and a local demo with Docker Compose, publish an event through the API, and inspect its delivery to a sample receiver. The demo can simulate HTTP errors and outages, show attempts, and replay an exhausted delivery. Both successful and failed paths must work without paid services.

The delivery guarantee is **at least once**, not exactly once. Consumers must use the stable event ID to deduplicate. A crash after an HTTP request succeeds but before the result is committed may cause a duplicate delivery.

## 3. Version 1 scope

### Included

- A versioned HTTP API to create projects, register destinations, publish events, inspect deliveries, and replay exhausted deliveries.
- An operator key generated during installation bootstrap; project-scoped keys with separate publish and manage permissions. Show keys once and store only their hashes.
- Event type subscriptions per destination. One published event creates one independent delivery per matching destination.
- An `Idempotency-Key` unique within each project. Repeating a request with the same key and content returns the original event; reusing the key with different content returns `409`.
- A transaction that persists the event and its deliveries before the API returns `202 Accepted`.
- A separate worker process that claims due deliveries in PostgreSQL, sends signed POST requests, records attempts, and retries transient failures.
- Manual replay of an exhausted delivery without removing its earlier attempt history.
- A demo event generator and receiver available only in the local Compose profile.
- Structured logs, OpenTelemetry metrics and traces, and health checks for the API and worker.
- Versioned API and worker images published to GHCR, with Compose installation pinned to a release version.
- A reproducible local benchmark that reports throughput, latency, failure rate, hardware, configuration, and test procedure.

### Excluded from version 1

- Web dashboard, user sign-up, billing, plans, OAuth, and an author-hosted public instance.
- A .NET service, SDK, or sample receiver. A .NET consumer is the first planned extension after version 1.
- Kafka, Redis, Kubernetes, exactly-once delivery, and ordering guarantees between deliveries.
- Payload transformation, complex routing rules, and non-TLS external destinations in production.
- Any paid service or cloud account needed to run the application, tests, or demo.

## 4. Architecture and data flow

1. An operator bootstraps an installation and creates a project. Project credentials are created with an administrative command or an operator-authenticated API call.
2. The project registers HTTPS destinations and their subscribed event types. The platform validates each destination against its network policy.
3. A publisher sends `POST /v1/events` with an event type, a JSON data object, and an `Idempotency-Key`. The API authenticates, validates, and atomically persists the event and deliveries before returning `202` and the event ID.
4. A worker claims a batch of due deliveries using PostgreSQL `FOR UPDATE SKIP LOCKED` and a time-limited lease. The outbound HTTP call runs outside the claim transaction.
5. The worker records the response status, duration, and outcome. `2xx` completes the delivery; transient failures schedule another attempt; permanent failures or exhaustion move it to `failed`.
6. If a worker dies, its lease expires and another worker can resume the delivery. Duplicate HTTP calls remain possible under the at-least-once guarantee.

**Components:** Fastify/TypeScript API, Node.js/TypeScript worker, PostgreSQL, and local demo generator/receiver. API and worker share domain and persistence modules but run as separate processes and Compose services. PostgreSQL is the sole source of truth and the initial work queue.

**Data model:** `projects`, `api_keys`, `endpoints`, `events`, `deliveries`, and immutable `delivery_attempts`. Every project query and mutation is scoped by `project_id`. Deliveries hold `next_attempt_at`, `lease_until`, a lease ownership token, attempt count, and current state.

## 5. Initial HTTP contract

| Operation                                 | Authorization       | Result                                               |
| ----------------------------------------- | ------------------- | ---------------------------------------------------- |
| `POST /v1/projects`                       | Operator key        | Create a project                                     |
| `POST /v1/projects/{id}/keys`             | Operator key        | Create a project key; reveal its secret once         |
| `POST /v1/endpoints`, `GET /v1/endpoints` | Project manage key  | Create and list destinations and subscriptions       |
| `POST /v1/events`                         | Project publish key | Return `202`, `eventId`, and delivery IDs            |
| `GET /v1/events/{id}`                     | Project manage key  | Read event and delivery states                       |
| `GET /v1/deliveries/{id}`                 | Project manage key  | Read state and attempt history                       |
| `POST /v1/deliveries/{id}/replay`         | Project manage key  | Schedule a new attempt cycle for a terminal delivery |

Publish and manage keys identify the project; `POST /v1/events` does not accept a client-controlled project ID. Publish the OpenAPI schema in the repository and serve it from the API.

The consumer receives a stable JSON envelope with `id`, `type`, `createdAt`, and `data`. Headers carry event ID, delivery ID, timestamp, and an HMAC-SHA256 signature over `timestamp + "." + exact body bytes`. Documentation includes signature verification and deduplication examples.

## 6. Delivery and failure policy

- Default request timeout: 5 seconds, operator-configurable within documented limits.
- Default maximum: 5 total attempts. Retry intervals after the first failure are approximately 1, 5, 30, and 120 minutes, with jitter. The local demo uses shorter intervals.
- Retry network errors, timeouts, HTTP `408`, `429`, and `5xx`. Treat other `4xx` and redirects as terminal. Never follow redirects.
- Only the worker holding a valid lease token can commit an attempt outcome. Tests must cover lease expiry, worker restart, and concurrent claims.
- Manual replay starts a new attempt cycle while preserving the original event and all earlier attempts. Audit who requested it and when.
- Do not promise order across events or destinations. Explain duplicate and out-of-order handling to consumers.
- Default retention for payloads and attempts is 30 days, configurable by the operator. Cleanup must avoid blocking active deliveries.

## 7. Security and limits

- Require HTTPS for external destinations. The local demo may target only its fixed Compose receiver; project keys cannot enable this exception in production.
- Resolve and validate the destination on every attempt, then connect only to the validated address to avoid a DNS change between validation and connection. Reject private, loopback, link-local, cloud metadata, and other reserved addresses, including IPv4, IPv6, and DNS variants. Do not follow redirects.
- Store API keys as hashes, use constant-time comparison where applicable, rate-limit requests by project, and audit administrative actions without logging credentials.
- Encrypt each destination's HMAC secret at rest with an installation master key. Reveal secrets once; never include them in logs or read responses.
- Limit event JSON to 64 KiB and captured destination response text to a sanitized 2 KiB excerpt. Never log authorization headers or event bodies.
- Document the threat model and the recommended network configuration for self-hosted operators.

## 8. Tests and acceptance criteria

**Test levels:** unit tests for domain rules; integration tests against real PostgreSQL for transactions, idempotency, and concurrent claims; end-to-end tests with a local HTTP receiver for signatures, `2xx`, `4xx`, `429`, `5xx`, timeouts, replay, and worker crash/restart. Inject a clock where useful so tests do not depend on long sleeps.

**Coverage gate:** CI requires at least 85% line coverage and 80% branch coverage across maintained TypeScript code, excluding generated code, migrations, and fixtures. Coverage numbers do not replace the mandatory concurrency, security, and recovery tests.

**Acceptance checks:**

1. `docker compose up` starts API, worker, PostgreSQL, and demo receiver. The README reproduces a successful delivery and a failed delivery followed by replay.
2. Concurrent publishers using one idempotency key do not create duplicate events. Two workers do not simultaneously own one valid lease. A crash after sending may cause a duplicate, as documented.
3. The demo receiver rejects an altered signature. Unauthorized internal destinations are rejected.
4. CI runs lint, typecheck, tests, coverage, image builds, and a Compose startup smoke test. A failed check prevents release publishing.
5. A `vX.Y.Z` tag after passing CI publishes public GHCR images with a version tag and verifiable digest. A user can install that release with Compose without compiling locally.
6. A machine without commercial service credentials can run the full test suite and local demo. Instructions require no private packages or images.
7. The benchmark is repeatable from documented commands and clearly separates measured results from projections.

## 9. GitHub workflow and release

- Public repository with Apache-2.0 license, English `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, OpenAPI documentation, request examples, and short ADRs under `docs/adr/`.
- Proposed structure: `apps/api`, `apps/worker`, `apps/demo-receiver`, `packages/core`, `packages/db`, `docs`, `deploy/compose`, and `.github/workflows`.
- Pull requests run checks; `main` stays releasable. Semantic version tags trigger GitHub Actions to publish images with `GITHUB_TOKEN`. Make GHCR packages public for anonymous installation.
- Automation publishes installable artifacts; it does not run an author-hosted instance. Operators decide when to update their own installation, following documented migration steps.
- Keep commits coherent and use clear English imperative subjects, such as `Add transactional event ingestion` and `Handle expired delivery leases`. Do not add `Co-authored-by` trailers.
- Use Issues and milestones for foundation, ingestion, delivery, security/observability, and release. Comment on GitHub Project cards or Issues only when recording a technical decision, blocker, scope change, or verification evidence. Routine progress belongs in the card state, commit, or pull request; do not duplicate it in comments. All such comments must be in English.
- During implementation, explain each phase to the user in Portuguese: the problem, chosen design, meaningful alternative, and a test that proves the behavior. Code, code comments, commits, and public documentation remain in English.

## 10. Planned implementation sequence

1. Foundation: repository structure, Compose, PostgreSQL, migrations, CI, OpenAPI, and commit rules.
2. Ingestion: projects/keys, destinations, events, and transactional idempotency.
3. Delivery: concurrent claims, signing, failure policy, and attempt history.
4. Security and operations: destination protection, rate limits, telemetry, retention, and recovery tests.
5. Open source experience: demo, documentation, benchmark, GHCR images, release, and a clean install from a tag.

The implementation plan must split these into demonstrable increments, pair each increment with failure tests, and explicitly verify zero cost, clean installation, coverage, commit authorship, and image publication.

## 11. Post-V1 extension

Build an ASP.NET Core reference consumer that verifies the signature and timestamp, deduplicates by event ID, records outcomes, and has interoperability tests against the Node.js platform. Consider secret rotation, an operations dashboard, an external queue adapter, or a Kubernetes example only after feedback from users.

## References

- [GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- [PostgreSQL `FOR UPDATE SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html)
- [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [GitHub Actions for public repositories](https://docs.github.com/en/actions/concepts/billing-and-usage)
- [GitHub Packages and GHCR billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)
- [Publishing Docker images with GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
