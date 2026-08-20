CREATE TABLE executor_runs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  requested_executor executor_kind NOT NULL,
  executor executor_kind,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'expired')),
  workspace_path text,
  session_id text,
  output text,
  error_category text CHECK (
    error_category IS NULL OR error_category IN (
      'cancelled',
      'timeout',
      'validation',
      'unauthorized',
      'dependency',
      'rate_limited',
      'tool',
      'sandbox',
      'internal'
    )
  ),
  error_code text,
  error_message text,
  error_retryable boolean,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (task_id, attempt)
);

CREATE INDEX executor_runs_task_started_idx
  ON executor_runs (task_id, started_at DESC);

CREATE TABLE executor_events (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES executor_runs(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  executor executor_kind NOT NULL,
  correlation_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  sequence integer NOT NULL CHECK (sequence >= 0),
  kind text NOT NULL CHECK (
    kind IN (
      'started',
      'progress',
      'tool_call',
      'tool_result',
      'approval_required',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, sequence)
);

CREATE INDEX executor_events_task_created_idx
  ON executor_events (task_id, created_at, sequence);

CREATE TABLE workspace_bindings (
  run_id uuid PRIMARY KEY REFERENCES executor_runs(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_path text NOT NULL,
  sandbox_kind text NOT NULL CHECK (sandbox_kind IN ('local_workspace', 'hyperv')),
  bound_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE INDEX workspace_bindings_active_idx
  ON workspace_bindings (bound_at)
  WHERE released_at IS NULL;
