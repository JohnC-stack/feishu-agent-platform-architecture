ALTER TABLE platform_config_versions
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN change_summary text NOT NULL DEFAULT '',
  ADD COLUMN base_version integer,
  ADD COLUMN validation jsonb NOT NULL DEFAULT '{"valid":false,"errors":["Configuration has not been validated."],"warnings":[]}'::jsonb,
  ADD COLUMN updated_by text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN activated_by text,
  ADD COLUMN superseded_at timestamptz;

CREATE UNIQUE INDEX platform_config_versions_one_active_idx
  ON platform_config_versions ((status))
  WHERE status = 'active';

CREATE INDEX platform_config_versions_status_version_idx
  ON platform_config_versions (status, version DESC);

ALTER TABLE platform_config_versions
  ADD CONSTRAINT platform_config_versions_base_version_positive
  CHECK (base_version IS NULL OR base_version > 0);

COMMENT ON TABLE platform_config_versions IS
  'Immutable platform configuration history. Only allowlisted non-secret runtime settings are permitted.';
COMMENT ON COLUMN platform_config_versions.validation IS
  'Server-side validation result. Secret values, credentials and connection strings are prohibited.';
