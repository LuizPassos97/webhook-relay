# Security

This document describes what Webhook Relay protects, who it trusts, how each threat is handled and what it does not cover. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Trust boundaries

| Actor                        | Trust                                      | Can                                                                         |
| ---------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Operator (operator key)      | Full control of the installation           | Create projects and project keys                                            |
| Project `manage` key         | One project                                | Register endpoints, read events, deliveries and attempts, replay deliveries |
| Project `publish` key        | One project                                | Publish events                                                              |
| Consumer endpoints           | **Untrusted**: any URL a project registers | Receive signed requests; control response status, timing and body           |
| PostgreSQL, master key, host | Trusted                                    | Anyone with database and master key access can read all data and secrets    |

Project keys identify their project; clients never send a project ID, so a key cannot act on another project. Every query filters by the key's project, and an ID from another project returns `404`, the same as a missing one.

## Threats and mitigations

### Server-side request forgery

Endpoint URLs are attacker-controlled input that makes the worker send requests from inside your network.

- Only `https://` URLs without credentials or fragments are accepted. The only exception is the exact `DEMO_ORIGIN` in development, which production configuration forbids.
- Before **every** attempt, the hostname is resolved and **all** answers must be public unicast addresses. Loopback, private, link-local (including cloud metadata at `169.254.169.254`), carrier-grade NAT, multicast, reserved and IPv4-mapped IPv6 forms are rejected. If any answer is non-public, the destination is rejected.
- The connection uses only the validated addresses; there is no second DNS lookup, so a DNS change between check and connection (DNS rebinding) cannot redirect the request. TLS still verifies the certificate for the original hostname.
- Redirects are never followed; `3xx` responses fail the delivery.
- Registration also rejects literal private IPs and `localhost` early, but the per-attempt check is the one that matters.

### Stolen or leaked credentials

- API keys are 256-bit random tokens with a recognizable `wr_` prefix, shown once and stored only as SHA-256 hashes.
- Endpoint signing secrets are encrypted at rest with AES-256-GCM using the installation master key and a fresh nonce per value; they are shown once at creation and never returned by read routes.
- Authorization headers, idempotency keys, event bodies and secrets are not logged. Telemetry contains IDs and outcomes only.
- The master key can be loaded from a file (`MASTER_KEY_FILE`) so it does not have to sit in the environment.

### Forged or replayed webhooks at the consumer

- Each request is signed with HMAC-SHA256 over `<timestamp>.<exact body bytes>` using the endpoint secret.
- Consumers reject timestamps older than five minutes, which limits replay of captured requests, and compare signatures in constant time. The README includes a tested example.

### Tenant isolation

- Composite foreign keys tie deliveries to the event and endpoint of the same project at the database level.
- Integration tests check that events, deliveries and replays from another project are invisible.

### Abuse and resource exhaustion

- Per-project rate limit shared by all API processes (atomic PostgreSQL counter).
- Request bodies are limited (64 KiB of event data, 16 KiB for other routes); unknown fields are rejected.
- Each attempt has a total deadline covering DNS, connection, request and response; only the first 2 KiB of a response is read and stored after removing control characters and any echo of the secret.
- Workers run a bounded number of requests concurrently.

## Known limitations

- **No key revocation or rotation API.** Keys can be revoked by setting `api_keys.revoked_at` in the database. Endpoint secrets cannot be rotated without recreating the endpoint.
- **Single master key without rotation.** Losing it makes stored endpoint secrets unrecoverable; rotating it requires re-encrypting every endpoint secret, for which no tool exists yet. See [backups](operations.md#backups-and-master-key).
- **The operator key is all-powerful** and there is no audit log for operator actions (replays are audited).
- **Fixed-window rate limiting** can allow up to twice the limit across a window boundary.
- **DNS-based egress checks do not replace network controls.** If the worker runs behind an HTTP proxy or in a network where public addresses route to internal services, add an egress firewall. Run workers in a network segment without access to internal systems where possible.
- **TLS trust** uses Node.js's bundled certificate authorities; there is no certificate pinning or mutual TLS.
- **Duplicates are possible** by design (see [ADR 0002](adr/0002-at-least-once.md)); consumers must deduplicate.
- **The demo receiver** has unauthenticated control routes and must never be exposed or used in production.
- Retention deletes replay audit rows together with their events.

## Recommended deployment

- Serve the API behind TLS termination; do not expose PostgreSQL publicly.
- Give workers outbound internet access but no access to internal networks or metadata services.
- Store the master key and database credentials as files (Docker secrets or equivalent) and back up the master key separately from the database.
- Set `NODE_ENV=production`, which rejects the demo origin and retry scaling.
