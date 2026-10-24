-- Persist the result of every dashboard or scheduled model probe.
-- A model is advertised by the public catalog only after a recent working probe.
CREATE TABLE IF NOT EXISTS model_catalog_health (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  tested_at TEXT NOT NULL,
  error TEXT,
  status_code INTEGER,
  is_quota INTEGER NOT NULL DEFAULT 0,
  is_transient INTEGER NOT NULL DEFAULT 0,
  is_timeout INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_model_catalog_health_status
  ON model_catalog_health(status);

CREATE INDEX IF NOT EXISTS idx_model_catalog_health_tested_at
  ON model_catalog_health(tested_at);
