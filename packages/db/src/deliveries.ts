import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { conflict, notFound } from '../../core/src/errors.js';
import type { AttemptOutcome, NextStep } from '../../core/src/retry-policy.js';
import type { DeliverySummary } from './events.js';
import { withTransaction } from './pool.js';

export interface AttemptRecord {
  id: string;
  cycle: number;
  number: number;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: string;
  statusCode: number | null;
  durationMs: number | null;
  responseExcerpt: string | null;
}

export interface DeliveryDetails extends DeliverySummary {
  eventId: string;
  attempts: AttemptRecord[];
}

export interface ReplayResult {
  deliveryId: string;
  cycle: number;
}

/** Reads a delivery and its full attempt history. Returns null if it is not in this project. */
export async function getDelivery(
  pool: Pool,
  projectId: string,
  deliveryId: string,
): Promise<DeliveryDetails | null> {
  const delivery = await pool.query<{
    id: string;
    event_id: string;
    endpoint_id: string;
    state: DeliverySummary['state'];
    cycle: number;
    attempt_count: number;
    next_attempt_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT id, event_id, endpoint_id, state, cycle, attempt_count, next_attempt_at, completed_at
     FROM deliveries
     WHERE project_id = $1 AND id = $2`,
    [projectId, deliveryId],
  );
  const row = delivery.rows[0];
  if (!row) return null;

  const attempts = await pool.query<{
    id: string;
    cycle: number;
    number: number;
    started_at: Date;
    finished_at: Date | null;
    outcome: string;
    status_code: number | null;
    duration_ms: number | null;
    response_excerpt: string | null;
  }>(
    `SELECT id, cycle, number, started_at, finished_at, outcome, status_code, duration_ms,
            response_excerpt
     FROM delivery_attempts
     WHERE delivery_id = $1
     ORDER BY cycle, number`,
    [deliveryId],
  );

  return {
    id: row.id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    state: row.state,
    cycle: row.cycle,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    completedAt: row.completed_at,
    attempts: attempts.rows.map((attempt) => ({
      id: attempt.id,
      cycle: attempt.cycle,
      number: attempt.number,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at,
      outcome: attempt.outcome,
      statusCode: attempt.status_code,
      durationMs: attempt.duration_ms,
      responseExcerpt: attempt.response_excerpt,
    })),
  };
}

/**
 * Starts a new attempt cycle for a terminal delivery.
 *
 * The event and delivery IDs stay the same, so receivers can still deduplicate, and
 * earlier attempts are kept because each attempt row belongs to a specific cycle.
 * The state check is part of the UPDATE, so a delivery that is still active (or is
 * replayed twice concurrently) cannot be reset by a stale read.
 */
export async function replayDelivery(
  client: PoolClient,
  projectId: string,
  deliveryId: string,
  actorKeyId: string,
): Promise<ReplayResult> {
  const updated = await client.query<{ cycle: number }>(
    `UPDATE deliveries
     SET state = 'pending', cycle = cycle + 1, attempt_count = 0,
         next_attempt_at = now(), completed_at = NULL
     WHERE project_id = $1 AND id = $2 AND state IN ('succeeded', 'failed')
     RETURNING cycle`,
    [projectId, deliveryId],
  );

  const row = updated.rows[0];
  if (!row) {
    const exists = await client.query(
      'SELECT 1 FROM deliveries WHERE project_id = $1 AND id = $2',
      [projectId, deliveryId],
    );
    if (exists.rowCount === 0) throw notFound('Delivery');
    throw conflict('Only succeeded or failed deliveries can be replayed');
  }

  await client.query(
    'INSERT INTO replay_audit (id, delivery_id, actor_key_id, cycle) VALUES ($1, $2, $3, $4)',
    [randomUUID(), deliveryId, actorKeyId, row.cycle],
  );

  return { deliveryId, cycle: row.cycle };
}

/** A delivery owned by one worker until `leaseToken` expires. */
export interface ClaimedDelivery {
  id: string;
  projectId: string;
  eventId: string;
  endpointId: string;
  cycle: number;
  /** 1-based number of this attempt within the current cycle. */
  attemptNumber: number;
  leaseToken: string;
  url: string;
  /** Endpoint signing secret, still encrypted with the master key. */
  encryptedSecret: string;
  /** Exact envelope bytes to sign and send. */
  body: string;
}

/**
 * Claims up to `limit` due deliveries for `leaseMs` milliseconds.
 *
 * One statement selects due rows with SKIP LOCKED (so concurrent workers never wait on or
 * receive the same row), marks them as processing with a fresh lease token, and records the
 * attempt. Recording at claim time means an attempt is counted even if the worker dies
 * before it can report the result. All times come from the database clock.
 */
export async function claimDeliveries(
  pool: Pool,
  limit: number,
  leaseMs: number,
): Promise<ClaimedDelivery[]> {
  const result = await pool.query<{
    id: string;
    project_id: string;
    event_id: string;
    endpoint_id: string;
    cycle: number;
    attempt_count: number;
    lease_token: string;
    url: string;
    secret: string;
    body: string;
  }>(
    `WITH due AS (
       SELECT id FROM deliveries
       WHERE state = 'pending' AND next_attempt_at <= now()
       ORDER BY next_attempt_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     ),
     claimed AS (
       UPDATE deliveries AS d
       SET state = 'processing',
           lease_token = gen_random_uuid(),
           lease_until = now() + make_interval(secs => $2::double precision / 1000),
           attempt_count = d.attempt_count + 1
       FROM due
       WHERE d.id = due.id
       RETURNING d.id, d.project_id, d.event_id, d.endpoint_id, d.cycle, d.attempt_count,
                 d.lease_token
     ),
     attempts AS (
       INSERT INTO delivery_attempts (id, delivery_id, cycle, number, lease_token)
       SELECT gen_random_uuid(), id, cycle, attempt_count, lease_token FROM claimed
     )
     SELECT c.*, endpoint.url, endpoint.secret, event.body
     FROM claimed AS c
     JOIN endpoints AS endpoint ON endpoint.id = c.endpoint_id
     JOIN events AS event ON event.id = c.event_id`,
    [limit, leaseMs],
  );

  return result.rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    cycle: row.cycle,
    attemptNumber: row.attempt_count,
    leaseToken: row.lease_token,
    url: row.url,
    encryptedSecret: row.secret,
    body: row.body,
  }));
}

/**
 * Records an attempt's result, but only if the caller still owns the delivery.
 *
 * The compare-and-set on `lease_token` and `lease_until` means a worker whose lease expired
 * (for example after a long pause) cannot overwrite the state written by the worker that
 * took over. Returns false in that case and changes nothing.
 */
export async function finishAttempt(
  pool: Pool,
  claim: ClaimedDelivery,
  outcome: AttemptOutcome,
  next: NextStep,
): Promise<boolean> {
  const delayMs = next.state === 'pending' ? next.delayMs : 0;

  return withTransaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE deliveries
       SET state = $3,
           lease_token = NULL,
           lease_until = NULL,
           next_attempt_at = CASE
             WHEN $3 = 'pending' THEN now() + make_interval(secs => $4::double precision / 1000)
             ELSE next_attempt_at
           END,
           completed_at = CASE WHEN $3 = 'pending' THEN NULL ELSE now() END
       WHERE id = $1 AND lease_token = $2 AND lease_until > now()`,
      [claim.id, claim.leaseToken, next.state, delayMs],
    );
    if (updated.rowCount !== 1) return false;

    await client.query(
      `UPDATE delivery_attempts
       SET finished_at = now(), outcome = $2, status_code = $3, duration_ms = $4,
           response_excerpt = $5
       WHERE lease_token = $1`,
      [
        claim.leaseToken,
        outcome.kind,
        outcome.status ?? null,
        outcome.durationMs,
        outcome.excerpt ?? null,
      ],
    );
    return true;
  });
}

/**
 * Releases deliveries whose worker disappeared without finishing.
 *
 * The interrupted attempt is marked as abandoned and still counts toward the limit, so a
 * payload that crashes workers cannot be retried forever. Deliveries that already used
 * their last attempt become failed; the rest are due again immediately.
 * Returns the number of deliveries recovered.
 */
export async function recoverExpiredLeases(pool: Pool, maxAttempts: number): Promise<number> {
  const result = await pool.query<{ recovered: number }>(
    `WITH expired AS (
       SELECT id, lease_token FROM deliveries
       WHERE state = 'processing' AND lease_until <= now()
       FOR UPDATE SKIP LOCKED
     ),
     released AS (
       UPDATE deliveries AS d
       SET state = CASE WHEN d.attempt_count >= $1 THEN 'failed' ELSE 'pending' END,
           completed_at = CASE WHEN d.attempt_count >= $1 THEN now() ELSE NULL END,
           next_attempt_at = now(),
           lease_token = NULL,
           lease_until = NULL
       FROM expired
       WHERE d.id = expired.id
       RETURNING d.id
     ),
     abandoned AS (
       UPDATE delivery_attempts AS a
       SET outcome = 'abandoned', finished_at = now()
       FROM expired
       WHERE a.lease_token = expired.lease_token AND a.outcome = 'started'
     )
     SELECT count(*)::int AS recovered FROM released`,
    [maxAttempts],
  );
  return result.rows[0]?.recovered ?? 0;
}
