import { getDbInstance } from "./core";

export type ModelCatalogHealthStatus = "working" | "broken" | "rate_limited" | "slow" | "skipped";

export type ModelCatalogHealthRecord = {
  providerId: string;
  modelId: string;
  status: ModelCatalogHealthStatus;
  latencyMs: number;
  testedAt: string;
  error: string | null;
  statusCode: number | null;
  isQuota: boolean;
  isTransient: boolean;
  isTimeout: boolean;
};

export type ModelCatalogHealthInput = Omit<ModelCatalogHealthRecord, "testedAt"> & {
  testedAt?: string;
};

type HealthRow = {
  provider_id: string;
  model_id: string;
  status: string;
  latency_ms: number | null;
  tested_at: string;
  error: string | null;
  status_code: number | null;
  is_quota: number;
  is_transient: number;
  is_timeout: number;
};

const HEALTH_STATUSES = new Set<ModelCatalogHealthStatus>([
  "working",
  "broken",
  "rate_limited",
  "slow",
  "skipped",
]);

function normalizeStatus(value: string): ModelCatalogHealthStatus {
  return HEALTH_STATUSES.has(value as ModelCatalogHealthStatus)
    ? (value as ModelCatalogHealthStatus)
    : "broken";
}

function mapRow(row: HealthRow): ModelCatalogHealthRecord {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    status: normalizeStatus(row.status),
    latencyMs: row.latency_ms ?? 0,
    testedAt: row.tested_at,
    error: row.error,
    statusCode: row.status_code,
    isQuota: row.is_quota === 1,
    isTransient: row.is_transient === 1,
    isTimeout: row.is_timeout === 1,
  };
}

export function upsertModelCatalogHealth(input: ModelCatalogHealthInput): void {
  const db = getDbInstance();
  const testedAt = input.testedAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO model_catalog_health
      (provider_id, model_id, status, latency_ms, tested_at, error, status_code,
       is_quota, is_transient, is_timeout)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET
       status = excluded.status,
       latency_ms = excluded.latency_ms,
       tested_at = excluded.tested_at,
       error = excluded.error,
       status_code = excluded.status_code,
       is_quota = excluded.is_quota,
       is_transient = excluded.is_transient,
       is_timeout = excluded.is_timeout`
  ).run(
    input.providerId,
    input.modelId,
    input.status,
    input.latencyMs,
    testedAt,
    input.error,
    input.statusCode,
    input.isQuota ? 1 : 0,
    input.isTransient ? 1 : 0,
    input.isTimeout ? 1 : 0
  );
}

export function listModelCatalogHealth(): ModelCatalogHealthRecord[] {
  try {
    const rows = getDbInstance()
      .prepare("SELECT * FROM model_catalog_health ORDER BY provider_id, model_id")
      .all() as HealthRow[];
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

export function listWorkingModelCatalogHealth(): ModelCatalogHealthRecord[] {
  try {
    const rows = getDbInstance()
      .prepare("SELECT * FROM model_catalog_health WHERE status = 'working'")
      .all() as HealthRow[];
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

export function isWorkingCatalogModel(
  providerId: string,
  candidates: string[],
  workingRecords: readonly ModelCatalogHealthRecord[] = listWorkingModelCatalogHealth()
): boolean {
  const candidateIds = new Set(candidates.filter((candidate) => candidate.length > 0));
  return workingRecords.some(
    (record) =>
      record.providerId === providerId &&
      [...candidateIds].some(
        (candidate) =>
          record.modelId === candidate || record.modelId.endsWith(`/${candidate}`)
      )
  );
}
