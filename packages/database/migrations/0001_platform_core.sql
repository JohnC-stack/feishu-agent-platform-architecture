CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE task_status AS ENUM (
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'expired'
);

CREATE TYPE executor_kind AS ENUM ('direct_tool', 'api_agent', 'agent_cli');
CREATE TYPE risk_level AS ENUM ('low', 'medium', 'high', 'critical');

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel = 'feishu'),
  chat_id text NOT NULL,
  user_id text NOT NULL,
  summary text,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, chat_id, user_id)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  source_event_id text NOT NULL UNIQUE,
  correlation_id text NOT NULL,
  reply_target_id text NOT NULL,
  status task_status NOT NULL DEFAULT 'queued',
  executor executor_kind,
  risk risk_level NOT NULL DEFAULT 'low',
  input jsonb NOT NULL,
  output jsonb,
  error_code text,
  error_message text,
  idempotency_key text UNIQUE,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tasks_status_queued_at_idx ON tasks (status, queued_at);
CREATE INDEX tasks_correlation_id_idx ON tasks (correlation_id);

CREATE TABLE task_events (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  kind text NOT NULL,
  message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, sequence)
);

CREATE INDEX task_events_task_created_idx ON task_events (task_id, created_at);

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by text NOT NULL,
  decided_by text,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'revoked')),
  operation jsonb NOT NULL,
  decision_reason text,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX approval_requests_pending_task_idx
  ON approval_requests (task_id)
  WHERE status = 'pending';

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  correlation_id text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  outcome text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_correlation_created_idx ON audit_events (correlation_id, created_at);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id, created_at);
