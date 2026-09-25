# ADR 0001: Use PostgreSQL as the delivery queue

- **Status:** accepted
- **Date:** 2026-09-25

## Context

Every published event must produce durable deliveries that survive process crashes, can be retried hours later, inspected through the API and replayed. The project must be easy to self-host without paid services, and a reviewer should be able to reason about its correctness from the code.

The events and deliveries already live in PostgreSQL as the system of record. The question is whether the work queue should live there too or in a dedicated broker such as RabbitMQ, Redis or Kafka.

## Decision

PostgreSQL is both the system of record and the queue.

- The API inserts the event and all its deliveries in **one transaction**. A delivery exists if and only if its event was accepted; there is no dual write to keep consistent.
- Workers claim due rows with `SELECT … FOR UPDATE SKIP LOCKED` in a single short statement that also sets a lease token, a lease expiry and the attempt record. Concurrent workers never block on or receive the same row.
- The HTTP request runs **outside** any transaction. Completion is a compare-and-set on the lease token and expiry, so only the current owner can record a result.
- Due work is found through partial indexes on `(next_attempt_at, id) WHERE state = 'pending'` and on `lease_until WHERE state = 'processing'`.

## Consequences

- One stateful dependency to install, back up and monitor. Backups capture the queue and the history together.
- Ingestion and fan-out are atomic, which makes idempotency (a unique key per project) straightforward.
- Throughput is bounded by PostgreSQL write capacity: every attempt costs a few row updates. The [benchmark](../benchmarks.md) measures this on a laptop; very high volumes would need partitioning or a broker.
- Polling adds up to `WORKER_POLL_MS` of latency when the queue is idle. `LISTEN/NOTIFY` could remove it later without changing the data model.
- Row churn on `deliveries` needs autovacuum to keep up; retention deletes old rows in small batches.

## Alternatives considered

- **Dedicated broker (RabbitMQ, Redis Streams, Kafka).** Higher throughput, but the event write and the enqueue become two systems to keep consistent (an outbox table would still be needed), and self-hosters would operate one more service. Rejected for version 1.
- **Holding a row lock during the HTTP request.** Simpler ownership, but it keeps a transaction and connection open for up to the request timeout per delivery, and a crashed worker would leave a hanging transaction until the connection dies. Rejected in favor of leases.
- **Advisory locks per delivery.** Tied to a session, so they do not survive connection pooling well and are invisible in the data. Rejected.
