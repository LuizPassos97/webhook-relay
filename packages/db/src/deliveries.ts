import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { conflict, notFound } from '../../core/src/errors.js';
import type { DeliverySummary } from './events.js';

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
