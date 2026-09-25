import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { conflict } from '../../core/src/errors.js';
import {
  buildEnvelope,
  contentHash,
  validateEventInput,
  validateIdempotencyKey,
  type EventInput,
} from '../../core/src/events.js';

export interface PublishedEvent {
  eventId: string;
  deliveryIds: string[];
  /** False when an earlier request with the same idempotency key already created the event. */
  created: boolean;
}

/**
 * Stores an event and one pending delivery per subscribed endpoint.
 *
 * Must run inside a transaction so the event and its deliveries become visible together.
 * Concurrent requests with the same idempotency key are serialized by the unique index:
 * the loser's insert waits for the winner to commit, then does nothing and reads the
 * winner's event instead. A different payload under the same key is a conflict.
 */
export async function publishEvent(
  client: PoolClient,
  projectId: string,
  idempotencyKey: string,
  input: EventInput,
  options: { traceParent?: string } = {},
): Promise<PublishedEvent> {
  validateIdempotencyKey(idempotencyKey);
  validateEventInput(input);

  const id = randomUUID();
  const hash = contentHash(input);
  const body = buildEnvelope({ id, type: input.type, data: input.data, createdAt: new Date() });

  const inserted = await client.query(
    `INSERT INTO events (id, project_id, idempotency_key, content_hash, type, body, trace_parent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_id, idempotency_key) DO NOTHING`,
    [id, projectId, idempotencyKey, hash, input.type, body, options.traceParent ?? null],
  );

  if (inserted.rowCount === 1) {
    const deliveryIds = await createDeliveries(client, projectId, id, input.type);
    return { eventId: id, deliveryIds, created: true };
  }

  return findExistingEvent(client, projectId, idempotencyKey, hash);
}

/** Fans out to the endpoints subscribed at publish time; later endpoints are not added. */
async function createDeliveries(
  client: PoolClient,
  projectId: string,
  eventId: string,
  eventType: string,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO deliveries (id, project_id, event_id, endpoint_id)
     SELECT gen_random_uuid(), project_id, $2, id
     FROM endpoints
     WHERE project_id = $1 AND $3 = ANY (event_types)
     RETURNING id`,
    [projectId, eventId, eventType],
  );
  return result.rows.map((row) => row.id).sort();
}

async function findExistingEvent(
  client: PoolClient,
  projectId: string,
  idempotencyKey: string,
  hash: string,
): Promise<PublishedEvent> {
  const existing = await client.query<{ id: string; content_hash: string }>(
    'SELECT id, content_hash FROM events WHERE project_id = $1 AND idempotency_key = $2',
    [projectId, idempotencyKey],
  );
  const event = existing.rows[0];
  if (!event) {
    // Only possible if the event was deleted (e.g. by retention) between the two statements.
    throw new Error('Idempotent event disappeared during publish');
  }
  if (event.content_hash !== hash) {
    throw conflict('Idempotency-Key was already used with different content');
  }

  const deliveries = await client.query<{ id: string }>(
    'SELECT id FROM deliveries WHERE project_id = $1 AND event_id = $2 ORDER BY id',
    [projectId, event.id],
  );
  return { eventId: event.id, deliveryIds: deliveries.rows.map((row) => row.id), created: false };
}

export type DeliveryState = 'pending' | 'processing' | 'succeeded' | 'failed';

export interface DeliverySummary {
  id: string;
  endpointId: string;
  state: DeliveryState;
  cycle: number;
  attemptCount: number;
  nextAttemptAt: Date;
  completedAt: Date | null;
}

export interface EventDetails {
  id: string;
  type: string;
  createdAt: string;
  data: unknown;
  deliveries: DeliverySummary[];
}

/** Reads an event and its delivery states. Returns null if it does not exist in this project. */
export async function getEvent(
  pool: Pool,
  projectId: string,
  eventId: string,
): Promise<EventDetails | null> {
  const event = await pool.query<{ body: string }>(
    'SELECT body FROM events WHERE project_id = $1 AND id = $2',
    [projectId, eventId],
  );
  const row = event.rows[0];
  if (!row) return null;

  const deliveries = await pool.query<{
    id: string;
    endpoint_id: string;
    state: DeliveryState;
    cycle: number;
    attempt_count: number;
    next_attempt_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT id, endpoint_id, state, cycle, attempt_count, next_attempt_at, completed_at
     FROM deliveries
     WHERE project_id = $1 AND event_id = $2
     ORDER BY id`,
    [projectId, eventId],
  );

  // The stored envelope is the source of truth for what receivers get.
  const envelope = JSON.parse(row.body) as Omit<EventDetails, 'deliveries'>;
  return {
    id: envelope.id,
    type: envelope.type,
    createdAt: envelope.createdAt,
    data: envelope.data,
    deliveries: deliveries.rows.map((delivery) => ({
      id: delivery.id,
      endpointId: delivery.endpoint_id,
      state: delivery.state,
      cycle: delivery.cycle,
      attemptCount: delivery.attempt_count,
      nextAttemptAt: delivery.next_attempt_at,
      completedAt: delivery.completed_at,
    })),
  };
}
