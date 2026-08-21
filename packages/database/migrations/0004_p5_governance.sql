CREATE TABLE governance_roles (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  system boolean NOT NULL DEFAULT false,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE governance_role_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'group', 'service')),
  principal_id text NOT NULL,
  role_id text NOT NULL REFERENCES governance_roles(id) ON DELETE CASCADE,
  managed_by text NOT NULL DEFAULT 'runtime',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_type, principal_id, role_id)
);

CREATE INDEX governance_role_bindings_principal_idx
  ON governance_role_bindings (principal_type, principal_id);

CREATE TABLE governed_operations (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by text NOT NULL,
  chat_id text NOT NULL,
  tool_name text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('read', 'write')),
  risk risk_level NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (
    status IN (
      'pending_approval',
      'approved',
      'executing',
      'succeeded',
      'failed',
      'rejected',
      'expired',
      'revoked'
    )
  ),
  approval_request_id uuid,
  execution_claim_token uuid,
  result_reference text,
  error_code text,
  expires_at timestamptz NOT NULL,
  executed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX governed_operations_task_created_idx
  ON governed_operations (task_id, created_at DESC);
CREATE INDEX governed_operations_status_expires_idx
  ON governed_operations (status, expires_at);

ALTER TABLE approval_requests
  ADD COLUMN operation_id uuid UNIQUE REFERENCES governed_operations(id) ON DELETE CASCADE,
  ADD COLUMN request_hash text,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE governed_operations
  ADD CONSTRAINT governed_operations_approval_request_fk
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id) ON DELETE SET NULL;

CREATE TABLE budget_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'group', 'task', 'model')),
  scope_id text NOT NULL,
  period text NOT NULL CHECK (period IN ('task', 'day', 'month')),
  token_limit bigint NOT NULL CHECK (token_limit >= 0),
  cost_limit_micros bigint NOT NULL CHECK (cost_limit_micros >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, period)
);

CREATE TABLE budget_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'group', 'task', 'model')),
  scope_id text NOT NULL,
  period text NOT NULL CHECK (period IN ('task', 'day', 'month')),
  window_key text NOT NULL,
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  cost_micros_used bigint NOT NULL DEFAULT 0 CHECK (cost_micros_used >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, period, window_key)
);

CREATE INDEX budget_usage_scope_window_idx
  ON budget_usage (scope_type, scope_id, period, window_key);

ALTER TABLE audit_events
  ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now() + interval '365 days'),
  ADD COLUMN redacted boolean NOT NULL DEFAULT true;

CREATE INDEX audit_events_expires_idx ON audit_events (expires_at);

CREATE TABLE credential_references (
  name text PRIMARY KEY,
  provider text NOT NULL CHECK (
    provider IN ('windows_credential_manager', 'enterprise_secret_manager')
  ),
  target text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE credential_references IS
  'Stores provider references only. Secret material must never be persisted in PostgreSQL.';
