CREATE TABLE projects (
  id uuid PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE api_keys (
  id uuid PRIMARY KEY, project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  hash text UNIQUE NOT NULL, permission text NOT NULL CHECK (permission IN ('operator','publish','manage')),
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  CHECK ((permission = 'operator') = (project_id IS NULL))
);
CREATE TABLE endpoints (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url text NOT NULL, event_types text[] NOT NULL, secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,id)
);
CREATE TABLE events (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL, content_hash text NOT NULL, type text NOT NULL, body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,idempotency_key), UNIQUE(project_id,id)
);
CREATE TABLE deliveries (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, event_id uuid NOT NULL, endpoint_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','succeeded','failed')),
  cycle integer NOT NULL DEFAULT 1, attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(event_id,endpoint_id), UNIQUE(project_id,id),
  FOREIGN KEY(project_id,event_id) REFERENCES events(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,endpoint_id) REFERENCES endpoints(project_id,id),
  CHECK ((state = 'processing') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX deliveries_due ON deliveries(next_attempt_at,id) WHERE state='pending';
CREATE INDEX deliveries_expired ON deliveries(lease_until) WHERE state='processing';
CREATE INDEX deliveries_project ON deliveries(project_id,created_at,id);
CREATE INDEX events_retention ON events(created_at);
CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  cycle integer NOT NULL, number integer NOT NULL, lease_token uuid NOT NULL UNIQUE,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'started', status_code integer, duration_ms integer, response_excerpt text,
  UNIQUE(delivery_id,cycle,number)
);
CREATE TABLE replay_audit (
  id uuid PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  actor_key_id uuid NOT NULL REFERENCES api_keys(id), cycle integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rate_windows (
  subject text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL
);
