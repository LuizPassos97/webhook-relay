import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { encryptSecret } from '../../core/src/secrets.js';

export interface EndpointInput {
  url: string;
  eventTypes: string[];
}

export interface CreatedEndpoint extends EndpointInput {
  id: string;
  projectId: string;
  /** Signing secret, shown to the caller once. It is stored encrypted. */
  secret: string;
}

const SECRET_PREFIX = 'whsec_';

/**
 * Registers a destination. URL policy checks (HTTPS, public address) belong to the
 * caller and are repeated by the worker before every attempt.
 */
export async function createEndpoint(
  client: PoolClient,
  projectId: string,
  input: EndpointInput,
  masterKey: Buffer,
): Promise<CreatedEndpoint> {
  const id = randomUUID();
  const secret = SECRET_PREFIX + randomBytes(32).toString('base64url');

  await client.query(
    'INSERT INTO endpoints (id, project_id, url, event_types, secret) VALUES ($1, $2, $3, $4, $5)',
    [id, projectId, input.url, input.eventTypes, encryptSecret(secret, masterKey)],
  );

  return { id, projectId, url: input.url, eventTypes: input.eventTypes, secret };
}

/** Public view of an endpoint. The signing secret is deliberately absent. */
export interface EndpointSummary extends EndpointInput {
  id: string;
  createdAt: Date;
}

export interface Page<T> {
  items: T[];
  /** Pass as `cursor` to fetch the next page; null on the last page. */
  nextCursor: string | null;
}

/** Lists a project's endpoints ordered by ID, using keyset pagination. */
export async function listEndpoints(
  pool: Pool,
  projectId: string,
  options: { limit: number; cursor?: string },
): Promise<Page<EndpointSummary>> {
  // Fetch one extra row to know whether another page exists.
  const result = await pool.query<{
    id: string;
    url: string;
    event_types: string[];
    created_at: Date;
  }>(
    `SELECT id, url, event_types, created_at
     FROM endpoints
     WHERE project_id = $1 AND ($2::uuid IS NULL OR id > $2)
     ORDER BY id
     LIMIT $3`,
    [projectId, options.cursor ?? null, options.limit + 1],
  );

  const rows = result.rows.slice(0, options.limit);
  const hasMore = result.rows.length > options.limit;
  return {
    items: rows.map((row) => ({
      id: row.id,
      url: row.url,
      eventTypes: row.event_types,
      createdAt: row.created_at,
    })),
    nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
  };
}
