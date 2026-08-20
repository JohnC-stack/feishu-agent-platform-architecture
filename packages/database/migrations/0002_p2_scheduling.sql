ALTER TABLE conversations
  ADD COLUMN summary_version integer NOT NULL DEFAULT 0 CHECK (summary_version >= 0);

CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL,
  source_message_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, source_message_id)
);

CREATE INDEX conversation_messages_recent_idx
  ON conversation_messages (conversation_id, created_at DESC, id DESC);

CREATE TABLE route_rules (
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  priority integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  condition jsonb NOT NULL DEFAULT '{}'::jsonb,
  executor executor_kind NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE INDEX route_rules_active_priority_idx
  ON route_rules (priority DESC, id, version DESC)
  WHERE enabled = true;

ALTER TABLE tasks
  ADD COLUMN route_rule_id text,
  ADD COLUMN route_rule_version integer CHECK (route_rule_version > 0),
  ADD COLUMN input_summary text,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD CONSTRAINT tasks_route_rule_pair_check CHECK (
    (route_rule_id IS NULL AND route_rule_version IS NULL)
    OR (route_rule_id IS NOT NULL AND route_rule_version IS NOT NULL)
  );

CREATE TABLE task_attempts (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  worker_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz,
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'expired', 'stalled')),
  error_code text,
  error_message text,
  UNIQUE (task_id, attempt)
);

CREATE INDEX task_attempts_active_idx
  ON task_attempts (started_at)
  WHERE finished_at IS NULL;

CREATE INDEX tasks_dead_lettered_idx
  ON tasks (dead_lettered_at)
  WHERE dead_lettered_at IS NOT NULL;
