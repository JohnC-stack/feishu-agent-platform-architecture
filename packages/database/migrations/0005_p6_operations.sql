CREATE TABLE service_instances (
  service text NOT NULL,
  instance_id text NOT NULL,
  version text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'degraded', 'offline')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service, instance_id)
);

CREATE INDEX service_instances_last_seen_idx ON service_instances (last_seen_at DESC);

CREATE TABLE operational_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_key text NOT NULL UNIQUE,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  category text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  correlation_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by text,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operational_alerts_status_severity_idx
  ON operational_alerts (status, severity, last_seen_at DESC);

CREATE TABLE admin_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('cancel', 'retry', 'cleanup', 'restart', 'rollback')),
  target_type text NOT NULL,
  target_id text NOT NULL,
  risk risk_level NOT NULL,
  requested_by text NOT NULL,
  confirmation text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending_approval', 'executing', 'succeeded', 'failed', 'rejected')
  ),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX admin_operations_created_idx ON admin_operations (created_at DESC);
CREATE INDEX admin_operations_target_idx ON admin_operations (target_type, target_id, created_at DESC);

CREATE TABLE platform_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  commit_sha text NOT NULL,
  environment text NOT NULL,
  status text NOT NULL CHECK (status IN ('planned', 'deploying', 'deployed', 'failed', 'rolled_back')),
  created_by text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deployed_at timestamptz,
  rolled_back_at timestamptz
);

CREATE INDEX platform_releases_created_idx ON platform_releases (created_at DESC);

CREATE TABLE platform_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_type text NOT NULL CHECK (backup_type IN ('database', 'configuration', 'full')),
  status text NOT NULL CHECK (status IN ('planned', 'running', 'completed', 'failed')),
  storage_reference text,
  encrypted boolean NOT NULL DEFAULT true,
  checksum text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  restore_verified_at timestamptz
);

CREATE INDEX platform_backups_created_idx ON platform_backups (created_at DESC);

CREATE TABLE platform_config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK (version > 0),
  checksum text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'superseded')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

COMMENT ON COLUMN service_instances.details IS
  'Operational metadata only. Secret values and credentials are prohibited.';
COMMENT ON COLUMN operational_alerts.details IS
  'Redacted diagnostic metadata only. Secret values and credentials are prohibited.';
COMMENT ON COLUMN platform_config_versions.configuration IS
  'Non-secret effective settings only. Store configured/source flags instead of values.';
