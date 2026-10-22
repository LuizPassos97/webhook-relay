# Portfolio walkthrough: five-minute failure demo

Show a delivery system under failure, not just a successful HTTP request. This is a presentation guide for the existing [`scripts/demo.ts`](../scripts/demo.ts), not a new demo runner or a production deployment recipe.

## Prepare before the five minutes

Use an isolated local demo installation, Docker Compose and the repository root. Build/start ahead of time: image downloads and builds are outside the presentation budget. The default Compose stack uses development-only HTTP destinations, accelerated retries and a master key persisted in a volume. Never expose the demo receiver: its control routes are unauthenticated.

These are the existing [failure-demo commands](operations.md#failure-demo):

```sh
docker compose up -d --build --wait
if BOOTSTRAP_RESULT=$(docker compose run --rm api node dist/scripts/bootstrap.js); then
  OPERATOR_KEY=$(printf '%s\n' "$BOOTSTRAP_RESULT" | tail -1)
else
  printf '%s\n' 'Bootstrap failed; retain the existing operator key and investigate.' >&2
fi
```

Bootstrap prints the operator token only for a fresh installation. The conditional checks its exit status before changing `OPERATOR_KEY`; do not proceed unless a fresh or securely retained operator credential is available. Store it privately, keep shell tracing off and do not show it on screen. If bootstrap reports that an operator already exists, use the securely retained token; repeating bootstrap cannot recover it. Do not delete volumes to recover a credential on an installation with valuable data.

Have the architecture diagram in the [README](../README.md#architecture), this guide and a terminal ready. A previous demo run leaves its project and endpoints in place; each run creates a new project, so scenarios do not share subscriptions with earlier runs.

If running Node.js processes instead, follow the complete [Node.js demo setup](operations.md#failure-demo) with installed dependencies, PostgreSQL, matching process environments, receiver, API and worker already running. Then the existing command is:

```sh
npm run demo
```

It requires `OPERATOR_KEY` in the environment. Defaults are API `http://localhost:3000` and receiver `http://localhost:4000`; use the documented demo configuration, not production settings. Do not generate a different master key for each process.

## 0:00–0:45 — State the problem and boundary

“Publishing a business event should not depend on every consumer being online. The API durably accepts an event and creates its deliveries in one PostgreSQL transaction; workers deliver later. A `202` means accepted, not delivered.”

Point to the API → database → worker → consumer diagram. Explain that publish and manage keys are project-scoped and distinct; the operator creates projects and keys. PostgreSQL is both system of record and queue, avoiding a separate broker at this scope.

## 0:45–2:00 — Run the existing scenarios

For the Docker setup above:

```sh
docker compose run --rm -e OPERATOR_KEY="$OPERATOR_KEY" \
  -e API_URL=http://api:3000 -e DEMO_RECEIVER_URL=http://demo-receiver:4000 \
  api node dist/scripts/demo.js
```

The script creates a project, separate manage/publish keys, four subscribed endpoints with different event types, and one event per scenario. It configures the receiver, publishes the scenarios concurrently, polls delivery state, fixes the broken consumer and replays its terminal delivery. It also sends a deliberately altered body directly to the receiver to test rejection.

Expected behavior from the runner and the existing operations guide, **not output collected by this document**:

| Scenario             | What to point out                                                 |
| -------------------- | ----------------------------------------------------------------- |
| Healthy              | Succeeds with `200`                                               |
| Fails twice          | Attempts `503, 503, 200`; transient failure is retried            |
| Times out once       | `timeout`, then `200`; a deadline releases worker capacity        |
| Always fails         | Five `503` attempts end in `failed`, not an infinite retry loop   |
| After fix and replay | Succeeds in cycle 2; earlier attempt history is retained          |
| Altered body         | Consumer returns `401` because body and signature no longer match |

The local configuration shortens retries; the roughly 20-second demo is not production retry timing or a performance benchmark. The runner waits for terminal states and exits nonzero if its assertions fail. If it fails, show the real error and use [troubleshooting](operations.md#troubleshooting); do not present expected output as an observed result.

## 2:00–3:00 — Explain the failure semantics

- Claims use `FOR UPDATE SKIP LOCKED` with a lease token; network I/O happens outside the transaction. Only the current lease owner can record completion.
- A worker crash after consumer receipt but before saving success can cause redelivery. This is **at least once**, never exactly once. Consumers verify signatures and deduplicate by event ID; there is no ordering guarantee.
- Replay keeps the same event and delivery IDs, increments the cycle and preserves attempts. It is available only for terminal deliveries and writes a replay audit row.
- Production retries use backoff/jitter and five attempts by default. Not every failure retries: redirects and most client errors fail immediately.

The scripted demo exercises errors, a timeout, exhaustion, replay and a forged request. It does **not** kill a worker, prove crash recovery live, demonstrate all SSRF defenses, or prove publisher idempotency through repeated requests. Point to [`tests/e2e/recovery.test.ts`](../tests/e2e/recovery.test.ts), the [receiving example](../README.md#receiving-webhooks) and the [security model](security.md) as source evidence, without claiming you ran tests during this presentation.

## 3:00–4:00 — Discuss deliberate tradeoffs

- **PostgreSQL queue:** fewer moving parts and transactional fanout, but API writes, claims, attempts and retention share database resources. See [ADR 0001](adr/0001-postgresql-queue.md). A broker would require a durable handoff strategy rather than a naive dual write.
- **Leases rather than exactly once:** crash recovery can resend requests, so consumer idempotency is a contract, not an optional optimization. See [ADR 0002](adr/0002-at-least-once.md).
- **Network/security boundary:** destinations require public HTTPS in production, are resolved/validated per attempt and pinned for connection; redirects are not followed. Egress controls still matter.
- **Operability:** attempts and trace context connect acceptance to retries/replays; readiness checks database access, not successful end-to-end delivery. Watch queue age as well as HTTP health.
- **Credential lifecycle:** project API-key replacement/revocation exists; operator-key recovery, signing-secret rotation and master-key re-encryption tooling do not. Use the [key lifecycle guide](key-lifecycle.md) to explain those gaps rather than implying a rotation API exists.

## 4:00–5:00 — Questions and honest evidence

| Interview question                                 | Answer to develop                                                                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Why not call consumers inside the API request?”   | Consumer outages/latency should not block durable acceptance; the queue decouples them.                                                                                                   |
| “What happens if two workers claim the same work?” | Row locking skips claimed candidates; leases allow recovery, while token-checked completion rejects stale owners. Duplicates can still occur across a crash boundary.                     |
| “How do you prevent duplicate business effects?”   | Durable publisher idempotency is project-scoped; receivers also need durable event-ID/business idempotency, including replay.                                                             |
| “How would you scale it?”                          | Observe queue age, completion latency and database contention; tune bounded concurrency/add workers, then measure before changing architecture.                                           |
| “How do you rotate a leaked signing secret?”       | There is no in-place route. Recreating an endpoint does not move old deliveries and overlapping subscriptions duplicate fanout; describe the limitations and incident choices explicitly. |
| “What would you build next?”                       | Audited operator recovery and versioned secret lifecycle, with concurrency/recovery tests; separate these proposals from shipped behavior.                                                |

### Performance evidence: pending runner benchmark

[`npm run benchmark`](../package.json) exists and [`docs/benchmarks.md`](benchmarks.md) describes the sink, acceptance/delivery phases, accounting checks and historical laptop measurements. Those tables are not a fresh measurement of this walkthrough, a CI runner result or a production capacity promise.

**A reproducible benchmark run on the target runner, with its captured output/artifact, is still pending.** Do not quote invented throughput, latency, speedups or runner specifications. This documentation change does not execute a demo, benchmark or load test. When collecting future evidence, use the existing [reproduction procedure](benchmarks.md#reproduce) in an isolated benchmark database and record commit, hardware/runtime/database configuration, worker settings, accepted/delivered/failed/pending counts, duplicates and raw output. Separate API acceptance from delivery throughput and completion latency; a local immediate-response sink excludes real consumer/network latency.

## After the presentation

Retain only sanitized output: scenario states, attempt outcomes, exit status and the revision used, never tokens or signing secrets. Stop the disposable demo with the existing `docker compose down` command when finished. This preserves volumes; the operations guide also documents `docker compose down --volumes`, which deletes the local database **and** master-key volumes and is appropriate only when intentionally discarding an isolated demo. Never use that cleanup on real data.
