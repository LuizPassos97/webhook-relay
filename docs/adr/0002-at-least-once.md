# ADR 0002: Guarantee at-least-once delivery, not exactly once

- **Status:** accepted
- **Date:** 2026-09-25

## Context

A delivery is an HTTP request to a system we do not control. Between the consumer processing the request and the worker recording the result, the worker can crash, lose its database connection or pause long enough for its lease to expire. In that window it is impossible to know whether the consumer acted on the request.

## Decision

Webhook Relay guarantees **at least once** delivery and makes duplicates easy to handle:

- A delivery is only marked done after a `2xx` response is recorded by the worker that still owns the lease. If that does not happen, the lease expires and another worker sends the request again.
- Every attempt of an event carries the same `X-Webhook-Id` and exactly the same body bytes, including retries and manual replays. Consumers deduplicate by that ID.
- The attempt interrupted by a crash is recorded as `abandoned` and counts toward the five-attempt limit, so a request that crashes workers cannot loop forever.
- No ordering is promised across events or endpoints; retries naturally reorder deliveries.

## Consequences

- Consumers must be idempotent. The README shows how to verify signatures and skip already processed event IDs.
- A worker crash right after a successful request produces a duplicate. The recovery test (`tests/e2e/recovery.test.ts`) kills a real worker process at that moment and asserts the duplicate is visible and identical.
- Operators never need to reconcile "maybe delivered" states manually: every delivery ends up `succeeded` or `failed`, and failed ones can be replayed.

## Alternatives considered

- **At most once** (mark as sent before sending). Loses events whenever a worker crashes mid-request. Rejected: silent loss is worse than a duplicate the consumer can detect.
- **Exactly once.** Would require the consumer to participate in a transaction protocol with us. Not possible over plain HTTP webhooks, and claiming it would be misleading.
