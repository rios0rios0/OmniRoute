import { getProviderConnections } from "@/lib/db/providers";
import {
  getModelSyncInternalBaseUrl,
  syncConnectionModels,
} from "@/shared/services/modelSyncScheduler";
import { runSingleModelTest } from "@/lib/api/modelTestRunner";
import { getAllActiveSyncedModels } from "@/lib/db/models/activeSyncedCatalog";
import {
  upsertModelCatalogHealth,
  type ModelCatalogHealthStatus,
} from "@/lib/db/modelCatalogHealth";
import type { JobRegistry } from "@/lib/jobRegistry/registry";

const MODEL_CATALOG_HEALTH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MODEL_CATALOG_HEALTH_CONCURRENCY = 4;

type CatalogModel = {
  id?: unknown;
  modelType?: unknown;
  supportedEndpoints?: unknown;
};

type HealthCandidate = { providerId: string; modelId: string };

function toHealthStatus(status: string): ModelCatalogHealthStatus {
  if (status === "ok") return "working";
  if (status === "rate_limited") return "rate_limited";
  if (status === "slow") return "slow";
  if (status === "error") return "broken";
  return "skipped";
}

async function syncActiveConnections(baseUrl: string): Promise<void> {
  const connections = await getProviderConnections();
  const active = connections.filter((connection) => connection.isActive !== false);
  await Promise.all(
    active.map((connection) =>
      syncConnectionModels(connection.id, connection.provider, baseUrl).catch(() => false)
    )
  );
}

async function getCandidates(baseUrl: string): Promise<HealthCandidate[]> {
  void baseUrl;
  const syncedModels = await getAllActiveSyncedModels();
  const seen = new Set<string>();
  const candidates: HealthCandidate[] = [];
  for (const [providerId, providerModels] of Object.entries(syncedModels)) {
    for (const value of providerModels) {
      const model = value as CatalogModel;
      const supportedEndpoints = Array.isArray(model.supportedEndpoints)
        ? model.supportedEndpoints
        : [];
    if (
      typeof model.id !== "string" ||
      (model.modelType !== undefined && model.modelType !== "chat") ||
      (supportedEndpoints.length > 0 &&
        !supportedEndpoints.some((endpoint) => endpoint === "chat" || endpoint === "responses"))
    )
      continue;
    const key = `${providerId}\u0000${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ providerId, modelId: model.id });
    }
  }
  return candidates;
}

async function runWithConcurrency(
  candidates: HealthCandidate[],
  worker: (candidate: HealthCandidate) => Promise<void>
): Promise<void> {
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (next < candidates.length) {
      const candidate = candidates[next++];
      await worker(candidate);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MODEL_CATALOG_HEALTH_CONCURRENCY, candidates.length) },
      runWorker
    )
  );
}

export async function runModelCatalogHealthCycle(): Promise<number> {
  const baseUrl = getModelSyncInternalBaseUrl();
  await syncActiveConnections(baseUrl);
  const candidates = await getCandidates(baseUrl);
  await runWithConcurrency(candidates, async ({ providerId, modelId }) => {
    const result = await runSingleModelTest({ providerId, modelId, streamChat: true });
    upsertModelCatalogHealth({
      providerId,
      modelId,
      status: toHealthStatus(result.status),
      latencyMs: result.latencyMs,
      error: result.error ?? null,
      statusCode: result.statusCode ?? null,
      isQuota: result.isQuota === true,
      isTransient: result.isTransient === true,
      isTimeout: result.isTimeout === true,
    });
  });
  return candidates.length;
}

export function registerModelCatalogHealthJob(registry: JobRegistry): void {
  const now = new Date().toISOString();
  registry.register({
    id: "model_catalog_health",
    type: "interval",
    cron: null,
    intervalMs: MODEL_CATALOG_HEALTH_INTERVAL_MS,
    enabled: true,
    envFlag: null,
    config: { interval: "hourly" },
    createdAt: now,
    updatedAt: now,
    handler: async () => ({
      success: true,
      recordsAffected: await runModelCatalogHealthCycle(),
    }),
  });
}
