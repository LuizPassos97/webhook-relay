import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
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
