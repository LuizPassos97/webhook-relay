import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashKey, issueKey } from '../../core/src/credentials.js';
import { withTransaction } from './pool.js';

export type ProjectPermission = 'publish' | 'manage';
export type Permission = 'operator' | ProjectPermission;

export interface IssuedKey {
  id: string;
  /** Null for the installation-wide operator key. */
  projectId: string | null;
  permission: Permission;
  /** Plain token, shown to the caller once. Only its hash is stored. */
  token: string;
}

export interface IssuedProjectKey extends IssuedKey {
  projectId: string;
  permission: ProjectPermission;
}

/** The identity behind an authenticated request. */
export interface KeyPrincipal {
  keyId: string;
  projectId: string | null;
  permission: Permission;
}

// Arbitrary constant; serializes concurrent bootstrap commands.
const BOOTSTRAP_LOCK_ID = 71942302;

export async function createProjectKey(
  client: PoolClient,
  projectId: string,
  permission: ProjectPermission,
): Promise<IssuedProjectKey> {
  const id = randomUUID();
  const { token, hash } = issueKey();

  await client.query(
    'INSERT INTO api_keys (id, project_id, hash, permission) VALUES ($1, $2, $3, $4)',
    [id, projectId, hash, permission],
  );

  return { id, projectId, permission, token };
}

export async function createOperatorKey(client: PoolClient): Promise<IssuedKey> {
  const id = randomUUID();
  const { token, hash } = issueKey();

  await client.query(
    "INSERT INTO api_keys (id, project_id, hash, permission) VALUES ($1, NULL, $2, 'operator')",
    [id, hash],
  );

  return { id, projectId: null, permission: 'operator', token };
}

/**
 * Creates the first operator key of an installation.
 * Returns null when an active operator key already exists, so running the
 * bootstrap command twice never prints a second credential.
 */
export async function bootstrapOperatorKey(pool: Pool): Promise<IssuedKey | null> {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_ID]);
    const existing = await client.query(
      "SELECT 1 FROM api_keys WHERE permission = 'operator' AND revoked_at IS NULL LIMIT 1",
    );
    if (existing.rowCount !== 0) return null;
    return createOperatorKey(client);
  });
}

/** Looks up an active key by its token. Returns null for unknown or revoked keys. */
export async function findActiveKey(pool: Pool, token: string): Promise<KeyPrincipal | null> {
  // Lookup is by hash, so the plain token never reaches the database or its logs.
  const result = await pool.query<{
    id: string;
    project_id: string | null;
    permission: Permission;
  }>('SELECT id, project_id, permission FROM api_keys WHERE hash = $1 AND revoked_at IS NULL', [
    hashKey(token),
  ]);
  const row = result.rows[0];
  if (!row) return null;

  return { keyId: row.id, projectId: row.project_id, permission: row.permission };
}
