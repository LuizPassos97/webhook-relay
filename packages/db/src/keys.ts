import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { issueKey } from '../../core/src/credentials.js';

export type ProjectPermission = 'publish' | 'manage';

export interface IssuedProjectKey {
  id: string;
  projectId: string;
  permission: ProjectPermission;
  /** Plain token, shown to the caller once. Only its hash is stored. */
  token: string;
}

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
