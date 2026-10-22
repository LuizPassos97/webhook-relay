# Key lifecycle

Operational strategy for the current implementation, not a new rotation API. Use this with the [security model](security.md) and [backup guide](operations.md#backups-and-master-key).

## Implemented capabilities

| Credential | Stored form | Available lifecycle operations |
| ---------- | ----------- | ------------------------------ |
| Project `publish` / `manage` API key | SHA-256 hash of a random `wr_` token | Operator issues a new key and revokes a project key by ID |
| Installation operator API key | Same hashed-token format | Bootstrap issues the first key only; no supported replacement or revocation interface |
| Endpoint signing secret | AES-256-GCM encrypted `whsec_` secret | Generated on endpoint creation; no update, rotation, deletion or disable route |
| Installation master key | Supplied to API and workers, not stored in the database | Configuration via `MASTER_KEY` or `MASTER_KEY_FILE`; no in-place rotation tool |

API tokens and endpoint secrets are returned only at issuance. Record project ID, key ID, permission, owner and deployment references in an inventory; keep plaintext credentials only in an access-controlled secret store. There is no key-list API or plaintext-token recovery route. Permissions are exact, not hierarchical: an operator cannot substitute for `manage` or `publish` on project routes.

## Project API keys: issue, validate clients, revoke old ID

For a planned replacement, keep an operator credential available throughout. Do not revoke the only working project credential before verifying its replacement. Treat the overlap as a bounded exposure window, not automatic expiry: keys have no configured expiration.

1. Retrieve the old **key ID** and project ID from the issuance inventory. Never use the raw token as a path parameter. If the old ID was not retained, the public API cannot enumerate it; stop and resolve the inventory gap through an approved administrative process rather than guessing IDs.
2. As operator, call `POST /v1/projects/{projectId}/keys` with `{"permission":"publish"}` or `{"permission":"manage"}`, matching the client's existing least privilege. A `201` response includes `id`, `projectId`, `permission` and the one-time `token`. Store the new ID separately from the new token.
3. Deliver the token through your secret-management/deployment system and update every client instance. Both keys remain usable during this rollout; there is no atomic client cutover.
4. Verify from the actual clients, not just from an operator session:
   - For `manage`, call `GET /v1/endpoints` and expect `200` for the intended project; follow `nextCursor` when inventorying endpoints.
   - For `publish`, send a controlled event with `POST /v1/events` and a deliberate `Idempotency-Key`; expect `202` and inspect the returned event/delivery IDs with a separate manage key. This probe can cause real deliveries. Coordinate the event type and consumer side effects; there is no dry-run or read-only publish-key validation route.
   - Check all deployments and background jobs have switched. The service has no last-used-per-key API or operator audit trail proving every client migrated.
5. Only after validation, revoke the old ID with the existing operator-only operation: `DELETE /v1/projects/{projectId}/keys/{oldKeyId}`. Expect `204` with no body. A retry for the same project key also returns `204`, preserving its first revocation time. A missing key, wrong project or operator-key target returns `404`.
6. Verify an otherwise valid request with the old token now returns `401`, and the replacement still works. A project key cannot revoke keys (`403`). Do not log tokens while collecting evidence.

Authentication queries PostgreSQL for an active hash on every request; there is no process-local key cache. Revocation affects subsequent authentication checks across API instances, but does **not** cancel requests already authenticated, remove accepted events or stop queued deliveries. Workers use endpoint secrets, not publisher tokens. Inspect pending/processing deliveries and their attempts through `GET /v1/events/{eventId}` and `GET /v1/deliveries/{deliveryId}` using known IDs; there is no global delivery-list endpoint.

For a confirmed leak, prioritize revoking the compromised project key immediately rather than waiting for a graceful rollout; accept and communicate the resulting client outage. Before revocation, rollback means retaining the old client configuration. After revocation there is no un-revoke route: use the verified replacement or issue another key with the operator credential.

## Operator-key gap and lockout prevention

**Implemented limitation:** the project revocation route explicitly excludes operator keys. `npm run bootstrap` (or its documented container equivalent) only creates a key if no active operator key exists. Re-running it with an active but lost or leaked operator token returns a failure and does not recover, print or replace that token. A hash in a database backup cannot reconstruct it. The internal `createOperatorKey` function is not an operator CLI or HTTP interface.

Keep the original operator token in a restricted secret store with tested emergency access and named custodians. Verify access before project-key maintenance; retain a separate working manage key when inspecting deliveries during a publisher-key incident. Do not revoke/delete database rows to make bootstrap run, and do not rely on an undocumented SQL recovery recipe. There is no supported self-service operator recovery/revocation procedure today.

If the operator token is lost, preserve existing credentials and data, restrict administrative access, and escalate to a reviewed recovery-tool change. If leaked, contain API access at the existing deployment/network boundary and coordinate an incident response; project-key revocation cannot neutralize it, and merely issuing project replacements leaves the attacker able to issue more. Backup restoration alone is not operator-token revocation and may restore compromised active hashes.

**Future work, not implemented:** an authenticated administrative replacement/revocation flow with an independently authorized recovery path, replacement validation before revocation, protection against removing the last usable operator, explicit incident override, audit records and lockout/recovery tests. These are requirements for a future tool/API, not commands available now.

## Endpoint signing secrets: recreation is not in-place rotation

`POST /v1/endpoints` issues a random secret; `GET /v1/endpoints` never returns it. The worker decrypts the endpoint secret at claim processing and signs each attempt over the timestamp and exact stored event body. There is no endpoint-secret update, key version, dual-signature, unsubscribe, disable or deletion interface.

Creating a replacement endpoint is possible, but it is **not** a transparent rotation:

- Fanout selects subscribed endpoints when an event is first accepted. Existing deliveries retain their original endpoint ID; creating a new endpoint does not move or backfill them. Repeating an idempotent publish returns the original deliveries; replay also targets the original endpoint.
- If old and new endpoints subscribe to the same event type in the same project, new events create deliveries to **both**, even if both URLs are the same. Neither subscription can currently be disabled through the API. Expect duplicate fanout as well as ordinary at-least-once duplicates.
- Consumer-side acceptance of two secrets is different from Relay rotating a secret: an independently implemented consumer may accept the old and new secret during migration, but each Relay endpoint still signs with its own single secret. The bundled demo receiver is not a dual-secret migration implementation.

For a planned, coordinated replacement:

1. Inventory endpoint IDs, consumers, subscriptions and known outstanding deliveries. Agree how retries, terminal failures and later manual replays will be handled; the normal retry window alone does not bound replay lifetime.
2. Prepare consumer verification and idempotency first. If using a dual-secret overlap at the same consumer, verify raw-body HMAC, timestamp tolerance and constant-time comparison for each allowed secret. Deduplicate on event ID across both endpoint deliveries, not only delivery ID. Keep secrets scoped to the intended consumer.
3. Create the new endpoint with a manage key and provision its one-time secret to the consumer securely. Coordinate publishers before sending traffic; the new subscription takes effect immediately. An overlap requires explicitly accepting duplicate fanout. For a clean API-only cutover, a distinct event type or a new project can isolate future publishing, but requires publisher changes and still does not transfer old deliveries.
4. Continue processing old deliveries with the old secret while monitoring known event/delivery IDs. Drain pending/processing work and decide how terminal deliveries that might be replayed will be reconciled. Stopping all workers can contain outbound traffic but is installation-wide, not an endpoint pause.
5. Do not claim retirement of the old endpoint after consumer cutover: it remains subscribed. Without a subscription-management feature, staying in the same project/type leaves continuing old fanout. Moving future publishing to an isolated project/type avoids it, at the cost of a larger migration.

For a compromised signing secret, continuing to accept the old secret lets an attacker forge requests; graceful overlap is not containment. Reject it at the consumer, accept that outstanding old-endpoint deliveries will fail, and reconcile affected business events explicitly. There is no API to reassign those deliveries to the new endpoint. Republishing business data as a new event changes the event ID and needs business-level deduplication/reconciliation.

**Future work, not implemented:** versioned endpoint secrets, a defined bounded verification overlap, subscription disable/update operations, and explicit policies for pending, claimed and replayed deliveries. Such a feature needs concurrency and failure tests before it can promise safe cutover.

## Master key, backups and recovery

The current format in [`secrets.ts`](../packages/core/src/secrets.ts) is base64 of `nonce | authentication tag | ciphertext`: a fresh 12-byte nonce, a 16-byte tag and AES-256-GCM ciphertext. There is no embedded key ID or key version. Configuration requires a 32-byte hex key; `MASTER_KEY_FILE` takes precedence over `MASTER_KEY` and is read at process startup, not hot-reloaded. API and workers must use the same key for the same database.

**No supported in-place rotation exists.** Replacing the environment variable/file and restarting processes does not re-encrypt existing secrets. A rolling change would mix keys: an API can create ciphertext that old-key workers cannot decrypt. Even a coordinated restart under a new key leaves old ciphertext unreadable. Do not attempt ad-hoc SQL or a manual decrypt/update loop against production.

**Possible operations today:** retain the current master key securely, restrict access, keep a separate protected backup, and test restoration in an isolated environment with controlled outbound traffic. Restore the database and its matching original master key together, apply required migrations per [operations](operations.md#backups-and-master-key), then verify a controlled signed delivery with the consumer; health/readiness checks only prove database access, not decryption of endpoint secrets. Restored leases can expire and be recovered, so restoration may resend already received events. Preserve consumer deduplication and inspect attempts before replaying.

If a key/configuration mismatch is suspected, stop affected workers to avoid consuming attempt budgets, restore the matching configuration and coordinate restart across writers/workers. Decryption errors leave leases to expire; recovery records abandoned attempts and eventually fails deliveries at the attempt limit. Replay terminal deliveries only after the underlying key problem is fixed.

If the original master key is irretrievably lost, encrypted endpoint secrets cannot be recovered from a database backup alone. Events, attempt history and hashed API keys remain, but old queued deliveries still point to unreadable secrets. A new master key and recreated endpoints can serve **new** traffic after consumer provisioning; they do not repair old deliveries. Apply the recreation/fanout cautions above and explicitly reconcile undelivered business events. This is disaster recovery with limitations, not rotation. If the database and master key were both exposed, assume all stored signing secrets are compromised; master-key replacement alone would not change those signing secrets even with re-encryption tooling.

**Future work, not implemented:** a reviewed re-encryption tool and coordinated migration runbook with key versioning, complete coverage checks, authenticated decryption validation, crash-safe resume/rollback, and backup/key-version retention. A safe migration must coordinate API writes and every worker/claimed attempt, prevent mixed-key writes, verify all ciphertext under the new key before removing the old key, and test restoration of historical backups with their matching key. Until this tooling exists, there is no supported master-key rotation command.

## Code references

- [API key persistence and bootstrap](../packages/db/src/keys.ts), [authentication](../apps/api/src/auth.ts), [project routes](../apps/api/src/routes/projects.ts).
- [Endpoint routes](../apps/api/src/routes/endpoints.ts), [endpoint persistence](../packages/db/src/endpoints.ts), [fanout at ingestion](../packages/db/src/events.ts).
- [Claims, replay and lease recovery](../packages/db/src/deliveries.ts), [worker decryption](../apps/worker/src/runner.ts), [configuration](../packages/core/src/config.ts).
