import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface Project {
  id: string;
  name: string;
  createdAt: Date;
}

export async function createProject(client: PoolClient, name: string): Promise<Project> {
  const result = await client.query<{ id: string; name: string; created_at: Date }>(
    'INSERT INTO projects (id, name) VALUES ($1, $2) RETURNING id, name, created_at',
    [randomUUID(), name],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Project insert returned no row');

  return { id: row.id, name: row.name, createdAt: row.created_at };
}
