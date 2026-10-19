/**
 * Model-scoped quota resolution — the self-service view of the upstream quota
 * windows that apply to one selected OmniRoute model.
 *
 * A client sends the model id it selected (for example `openai/gpt-5`, an
 * `auto/*` combo, or a stored combo name) and receives the quota windows that
 * can be attributed to that selection: the canonical 5h/7d/30d periods when the
 * upstream reports them, provider-native windows otherwise, plus honest
 * route-level scope for automatic/fallback routing. Values are only ever taken
 * from the caller's own connections — never another account's — and every
 * window carries its source and observation timestamp so clients can show
 * freshness and apply their own bounded caching. Missing data is never
 * presented as an unlimited limit.
 *
 * @module lib/usage/modelQuota
 */

import { getComboModelString } from "@/lib/combos/steps";
import { supportsProviderQuota } from "@/shared/utils/providerQuotaVisibility";
import type { ProviderLimitsCacheEntry } from "@/lib/db/providerLimits";
import { getCodexQuotaWindowFilterForModel } from "@omniroute/open-sse/config/codexQuotaScopes.ts";
import { quotaWindowNamesForScope } from "@omniroute/open-sse/services/antigravityQuotaFamily.ts";

type JsonRecord = Record<string, unknown>;

/** A reading older than this is still shown, but flagged `stale`. */
export const MODEL_QUOTA_STALE_MS = 15 * 60 * 1000;
/** Cached readings are reused for this long before a live refresh is attempted. */
export const MODEL_QUOTA_REFRESH_MS = 5 * 60 * 1000;
const MAX_MODEL_QUOTA_ROUTES = 16;

export type ModelQuotaWindowStatus = "available" | "stale" | "unavailable";
export type ModelQuotaStatus = "available" | "partial" | "stale" | "unavailable" | "unsupported";
export type ModelQuotaScopeType = "upstream-account-plan" | "aggregate" | "route";

export interface ModelQuotaWindow {
  /** Canonical bucket when the window maps to one (`5h`, `7d`, `30d`), else the provider's own window name. */
  period: string;
  /** Provider-native window key this reading came from. */
  windowName: string;
  status: ModelQuotaWindowStatus;
  /** Where the reading came from: the persisted provider-limits snapshot or the routing quota cache. */
  source?: "provider-limits" | "routing-observation";
  displayName?: string;
  usedPercentage?: number;
  remainingPercentage?: number;
  limit?: number;
  used?: number;
  remaining?: number;
  unlimited?: boolean;
  resetsAt?: string | null;
  observedAt?: string | null;
}

export interface ModelQuotaRoute {
  providerID: string | null;
  modelID: string | null;
  plan: string | number | boolean | null;
  status: ModelQuotaStatus;
  windows: ModelQuotaWindow[];
}

export interface ModelQuotaSnapshot {
  model: { providerID: "omniroute"; modelID: string };
  /** The single upstream provider/model the request resolves to; `null` for route-level scope. */
  resolved: { providerID: string; modelID: string } | null;
  scope: {
    type: ModelQuotaScopeType;
    providerID: string | null;
    /** The combo/`auto` name when the selection is a route rather than a single model. */
    route: string | null;
  };
  status: ModelQuotaStatus;
  plan: string | number | boolean | null;
  windows: ModelQuotaWindow[];
  /** Present for `aggregate`/`route` scope: per-candidate account/proxy quotas. */
  routes?: ModelQuotaRoute[];
  updatedAt: string;
}

export type ModelQuotaResult =
  | { ok: true; snapshot: ModelQuotaSnapshot }
  | {
      ok: false;
      code: "invalid_model" | "model_not_found" | "lookup_failed";
      message: string;
    };

/**
 * Type guard for {@link ModelQuotaResult} failures. The repository's base
 * tsconfig runs with `strict: false`, where TypeScript does not narrow
 * discriminated unions by boolean literals, so callers cannot rely on
 * `result.ok` alone to reach the failure fields.
 */
export function isModelQuotaFailure(
  result: ModelQuotaResult
): result is Extract<ModelQuotaResult, { ok: false }> {
  return result.ok === false;
}

interface ResolvedModelInfo {
  provider: string | null;
  model: string | null;
  errorType?: string;
  errorMessage?: string;
}

interface QuotaObservation {
  usedPercentage: number;
  resetAt: string | null;
  observedAt: string | null;
}

interface ConnectionLike {
  id: string;
  provider: string;
  isActive?: boolean;
  quotaVisible?: boolean;
  providerSpecificData?: unknown;
}

export interface ModelQuotaInput {
  model: string;
  refresh?: boolean;
  allowedConnections?: readonly string[] | null;
}

export interface ModelQuotaDeps {
  now?: () => number;
  getModelInfo?: (model: string) => Promise<ResolvedModelInfo>;
  getComboForModel?: (model: string) => Promise<JsonRecord | null>;
  getProviderConnections?: (filter?: JsonRecord) => Promise<unknown[]>;
  getProviderLimitsCache?: (connectionId: string) => ProviderLimitsCacheEntry | null;
  fetchAndPersistProviderLimits?: (
    connectionId: string,
    source: "manual"
  ) => Promise<{ cache?: ProviderLimitsCacheEntry | null }>;
  getQuotaWindowObservation?: (connectionId: string, windowName: string) => QuotaObservation | null;
  getQuotaWindows?: (provider: string) => readonly string[];
  resolveProviderAlias?: (provider: string) => string;
}

type RequiredDeps = Required<ModelQuotaDeps>;

async function normalizeDeps(deps: ModelQuotaDeps = {}): Promise<RequiredDeps> {
  const model =
    deps.getModelInfo && deps.getComboForModel ? null : await import("@/sse/services/model");
  const providers = deps.getProviderConnections ? null : await import("@/lib/db/providers");
  const providerLimits = deps.getProviderLimitsCache
    ? null
    : await import("@/lib/db/providerLimits");
  const usage = deps.fetchAndPersistProviderLimits
    ? null
    : await import("@/lib/usage/providerLimits");
  const quotaCache = deps.getQuotaWindowObservation ? null : await import("@/domain/quotaCache");
  const quotaPreflight = deps.getQuotaWindows
    ? null
    : await import("@omniroute/open-sse/services/quotaPreflight.ts");
  const providerAlias = deps.resolveProviderAlias
    ? null
    : await import("@omniroute/open-sse/services/providerAlias.ts");

  return {
    now: deps.now ?? Date.now,
    getModelInfo: deps.getModelInfo ?? model!.getModelInfo,
    getComboForModel: deps.getComboForModel ?? model!.getComboForModel,
    getProviderConnections: deps.getProviderConnections ?? providers!.getProviderConnections,
    getProviderLimitsCache: deps.getProviderLimitsCache ?? providerLimits!.getProviderLimitsCache,
    fetchAndPersistProviderLimits:
      deps.fetchAndPersistProviderLimits ?? usage!.fetchAndPersistProviderLimits,
    getQuotaWindowObservation:
      deps.getQuotaWindowObservation ?? quotaCache!.getQuotaWindowObservation,
    getQuotaWindows: deps.getQuotaWindows ?? quotaPreflight!.getQuotaWindows,
    resolveProviderAlias: deps.resolveProviderAlias ?? providerAlias!.resolveProviderAlias,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dedupeStrings(values: readonly unknown[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    if (typeof value !== "string" || !value.trim()) continue;
    const trimmed = value.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizePlanValue(value: unknown): string | number | boolean | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function connectionFromValue(value: unknown): ConnectionLike | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  if (!id || !provider || value.isActive === false) return null;
  return {
    id,
    provider,
    isActive: value.isActive === true,
    quotaVisible:
      value.quotaVisible === true ? true : value.quotaVisible === false ? false : undefined,
    providerSpecificData: value.providerSpecificData,
  };
}

function canonicalPeriod(windowName: string): string {
  const normalized = windowName.toLowerCase();
  if (/(^|[^a-z])5h([^a-z]|$)|session|five[-_ ]?hour/.test(normalized)) return "5h";
  if (/7d|week|weekly/.test(normalized)) return "7d";
  if (/30d|month/.test(normalized)) return "30d";
  return windowName;
}

function lookupQuotaRecord(quotas: JsonRecord | null | undefined, windowName: string): unknown {
  if (!isRecord(quotas)) return undefined;
  const target = windowName.trim().toLowerCase();
  for (const [key, value] of Object.entries(quotas)) {
    if (key.trim().toLowerCase() === target) return value;
  }
  return undefined;
}

interface QuotaRecordValues {
  usedPercentage?: number;
  remainingPercentage?: number;
  limit?: number;
  used?: number;
  remaining?: number;
  unlimited?: boolean;
  resetsAt: string | null;
  displayName?: string;
}

function readQuotaRecordValues(value: unknown): QuotaRecordValues | null {
  if (!isRecord(value)) return null;

  const used = finiteNumber(value.used);
  const total = finiteNumber(value.total) ?? finiteNumber(value.limit);
  const remaining = finiteNumber(value.remaining);
  const unlimited = value.unlimited === true;

  let usedPercentage = finiteNumber(value.usedPercentage);
  let remainingPercentage = finiteNumber(value.remainingPercentage);
  if (usedPercentage === undefined && !unlimited) {
    if (used !== undefined && total !== undefined && total > 0) {
      usedPercentage = clampPercent((used / total) * 100);
    } else if (used !== undefined && used >= 0 && used <= 100) {
      usedPercentage = clampPercent(used);
    }
  }
  if (usedPercentage === undefined && remainingPercentage !== undefined) {
    usedPercentage = clampPercent(100 - remainingPercentage);
  }
  if (remainingPercentage === undefined && usedPercentage !== undefined) {
    remainingPercentage = clampPercent(100 - usedPercentage);
  }

  const resetsAt =
    typeof value.resetAt === "string" && value.resetAt.trim() ? value.resetAt.trim() : null;
  const displayName =
    typeof value.displayName === "string" && value.displayName.trim()
      ? value.displayName.trim()
      : typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : undefined;

  const hasReading =
    usedPercentage !== undefined ||
    remainingPercentage !== undefined ||
    unlimited ||
    resetsAt !== null ||
    displayName !== undefined;
  if (!hasReading) return null;

  return {
    ...(usedPercentage !== undefined ? { usedPercentage } : {}),
    ...(remainingPercentage !== undefined ? { remainingPercentage } : {}),
    // Absolute amounts are only reported when the upstream names a total; a bare
    // `used` number without one is read as a percentage, never as an absolute.
    ...(total !== undefined && total >= 0 ? { limit: total } : {}),
    ...(total !== undefined && used !== undefined ? { used } : {}),
    ...(total !== undefined && remaining !== undefined ? { remaining } : {}),
    ...(unlimited ? { unlimited: true } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    resetsAt,
  };
}

function windowNamesForModel(
  providerId: string,
  modelId: string | null,
  cache: ProviderLimitsCacheEntry | null,
  deps: RequiredDeps
): string[] {
  const registered = deps.getQuotaWindows(providerId);
  const fromCache = isRecord(cache?.quotas) ? Object.keys(cache!.quotas as JsonRecord) : [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of [...registered, ...fromCache]) {
    if (typeof name !== "string" || !name.trim()) continue;
    const key = name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name.trim());
  }

  const normalizedProvider = deps.resolveProviderAlias(providerId).toLowerCase();
  if (normalizedProvider === "codex" && modelId) {
    const filter = getCodexQuotaWindowFilterForModel(modelId);
    if (filter) return names.filter((name) => filter(name));
  }

  return quotaWindowNamesForScope(names, { provider: providerId, requestedModel: modelId });
}

function buildWindow(
  windowName: string,
  recordValues: QuotaRecordValues | null,
  observation: QuotaObservation | null,
  cacheFetchedAtMs: number | null,
  now: number
): ModelQuotaWindow {
  const hasObservation = observation !== null;
  if (!recordValues && !hasObservation) {
    return { period: canonicalPeriod(windowName), windowName, status: "unavailable" };
  }

  const usedPercentage = hasObservation
    ? observation!.usedPercentage
    : recordValues?.usedPercentage;
  const remainingPercentage = hasObservation
    ? clampPercent(100 - observation!.usedPercentage)
    : recordValues?.remainingPercentage;
  const resetsAt = hasObservation
    ? (observation!.resetAt ?? recordValues?.resetsAt ?? null)
    : (recordValues?.resetsAt ?? null);
  const observedAt = hasObservation
    ? observation!.observedAt
    : cacheFetchedAtMs !== null
      ? new Date(cacheFetchedAtMs).toISOString()
      : null;
  const observedMs = observedAt !== null ? parseIsoMs(observedAt) : null;
  const stale = observedMs !== null && now - observedMs > MODEL_QUOTA_STALE_MS;

  return {
    period: canonicalPeriod(windowName),
    windowName,
    status: stale ? "stale" : "available",
    source: recordValues ? "provider-limits" : "routing-observation",
    ...(recordValues?.displayName !== undefined ? { displayName: recordValues.displayName } : {}),
    ...(usedPercentage !== undefined ? { usedPercentage: clampPercent(usedPercentage) } : {}),
    ...(remainingPercentage !== undefined
      ? { remainingPercentage: clampPercent(remainingPercentage) }
      : {}),
    ...(recordValues?.limit !== undefined ? { limit: recordValues.limit } : {}),
    ...(recordValues?.used !== undefined ? { used: recordValues.used } : {}),
    ...(recordValues?.remaining !== undefined ? { remaining: recordValues.remaining } : {}),
    ...(recordValues?.unlimited ? { unlimited: true } : {}),
    resetsAt,
    observedAt,
  };
}

interface EvaluatedConnection {
  supported: boolean;
  plan: string | number | boolean | null;
  windows: ModelQuotaWindow[];
}

async function persistOrReadCache(
  connection: ConnectionLike,
  refresh: boolean,
  deps: RequiredDeps,
  now: number
): Promise<ProviderLimitsCacheEntry | null> {
  let cache: ProviderLimitsCacheEntry | null = null;
  try {
    cache = deps.getProviderLimitsCache(connection.id);
  } catch {
    cache = null;
  }

  const fetchedAtMs = parseIsoMs(cache?.fetchedAt);
  const needsRefresh =
    refresh || cache === null || fetchedAtMs === null || now - fetchedAtMs > MODEL_QUOTA_REFRESH_MS;
  if (!needsRefresh) return cache;

  try {
    const result = await deps.fetchAndPersistProviderLimits(connection.id, "manual");
    return result?.cache ?? cache;
  } catch {
    // A refresh failure keeps the last known reading; its timestamp decides
    // whether the client sees `available` or `stale`, never invented values.
    return cache;
  }
}

async function evaluateConnection(
  connection: ConnectionLike,
  modelId: string | null,
  refresh: boolean,
  deps: RequiredDeps,
  now: number
): Promise<EvaluatedConnection> {
  const supported = supportsProviderQuota(connection.provider, connection);
  if (!supported) return { supported: false, plan: null, windows: [] };

  const cache = await persistOrReadCache(connection, refresh, deps, now);
  const cacheFetchedAtMs = parseIsoMs(cache?.fetchedAt);
  const windowNames = windowNamesForModel(connection.provider, modelId, cache, deps);

  const windows = windowNames.map((windowName) => {
    let observation: QuotaObservation | null = null;
    try {
      observation = deps.getQuotaWindowObservation(connection.id, windowName);
    } catch {
      observation = null;
    }
    const values = readQuotaRecordValues(
      lookupQuotaRecord(cache?.quotas as JsonRecord | null | undefined, windowName)
    );
    return buildWindow(windowName, values, observation, cacheFetchedAtMs, now);
  });

  return { supported: true, plan: normalizePlanValue(cache?.plan), windows };
}

function aggregateStatus(
  windows: readonly ModelQuotaWindow[],
  supported: boolean
): ModelQuotaStatus {
  if (!supported) return "unsupported";
  if (windows.length === 0) return "unavailable";

  const counts = { available: 0, stale: 0, unavailable: 0 };
  for (const window of windows) counts[window.status] += 1;
  if (counts.available === windows.length) return "available";
  if (counts.stale === windows.length) return "stale";
  if (counts.available + counts.stale === 0) return "unavailable";
  return "partial";
}

function aggregateRoutes(routes: readonly ModelQuotaRoute[]): ModelQuotaStatus {
  if (routes.length === 0) return "unavailable";
  if (routes.every((route) => route.status === "unsupported")) return "unsupported";
  const windows = routes.flatMap((route) => route.windows);
  if (windows.length === 0) return "unavailable";
  return aggregateStatus(windows, true);
}

async function rawConnections(deps: RequiredDeps): Promise<ConnectionLike[]> {
  let rows: unknown[] = [];
  try {
    rows = await deps.getProviderConnections({ isActive: true });
  } catch {
    rows = [];
  }
  return rows
    .map(connectionFromValue)
    .filter((connection): connection is ConnectionLike => connection !== null);
}

function isAllowed(connection: ConnectionLike, allowedConnections: readonly string[]): boolean {
  if (allowedConnections.length === 0) return true;
  return allowedConnections.includes(connection.id);
}

function scopedConnectionsForProvider(
  connections: readonly ConnectionLike[],
  providerId: string,
  allowedConnections: readonly string[],
  deps: RequiredDeps
): ConnectionLike[] {
  const canonical = deps.resolveProviderAlias(providerId).toLowerCase();
  return connections.filter(
    (connection) =>
      isAllowed(connection, allowedConnections) &&
      connection.quotaVisible !== false &&
      deps.resolveProviderAlias(connection.provider).toLowerCase() === canonical
  );
}

type RouteCandidate =
  { connection: ConnectionLike; modelId: string | null } | { unknownModel: string };

async function evaluateRoutes(
  candidates: readonly RouteCandidate[],
  refresh: boolean,
  deps: RequiredDeps,
  now: number
): Promise<ModelQuotaRoute[]> {
  const routes: ModelQuotaRoute[] = [];
  for (const candidate of candidates.slice(0, MAX_MODEL_QUOTA_ROUTES)) {
    if ("unknownModel" in candidate) {
      // The candidate's upstream is not knowable — report the target the
      // client's route names, never a guessed destination.
      routes.push({
        providerID: null,
        modelID: candidate.unknownModel,
        plan: null,
        status: "unavailable",
        windows: [],
      });
      continue;
    }
    const evaluated = await evaluateConnection(
      candidate.connection,
      candidate.modelId,
      refresh,
      deps,
      now
    );
    routes.push({
      providerID: candidate.connection.provider,
      modelID: candidate.modelId,
      plan: evaluated.plan,
      status: aggregateStatus(evaluated.windows, evaluated.supported),
      windows: evaluated.windows,
    });
  }
  return routes;
}

async function routeSnapshot(
  input: { model: string; refresh: boolean; allowedConnections: readonly string[] },
  routeName: string,
  targets: readonly string[],
  deps: RequiredDeps,
  now: number
): Promise<ModelQuotaResult> {
  const connections = await rawConnections(deps);

  const candidates: RouteCandidate[] = [];
  const seen = new Set<string>();
  const pushCandidate = (connection: ConnectionLike, modelId: string | null) => {
    const key = `${connection.id}::${modelId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ connection, modelId });
  };

  if (targets.length === 0) {
    // The route has no enumerable targets (built-in `auto/*`): every active
    // connection of the key is a candidate, and the route IDs stay unclaimed.
    for (const connection of connections) {
      if (!isAllowed(connection, input.allowedConnections) || connection.quotaVisible === false)
        continue;
      pushCandidate(connection, null);
    }
  } else {
    for (const target of targets) {
      let info: ResolvedModelInfo | null = null;
      try {
        info = await deps.getModelInfo(target);
      } catch {
        info = null;
      }
      const providerId = info?.provider && info.provider !== "auto" ? info.provider : null;
      if (!providerId) {
        const key = `unknown::${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ unknownModel: target });
        continue;
      }
      for (const connection of scopedConnectionsForProvider(
        connections,
        providerId,
        input.allowedConnections,
        deps
      )) {
        pushCandidate(connection, info?.model ?? target);
      }
    }
  }

  const routes = await evaluateRoutes(candidates, input.refresh, deps, now);
  const status = aggregateRoutes(routes);

  return {
    ok: true,
    snapshot: {
      model: { providerID: "omniroute", modelID: input.model },
      resolved: null,
      scope: { type: "route", providerID: null, route: routeName },
      status,
      plan: null,
      windows: [],
      routes,
      updatedAt: new Date(now).toISOString(),
    },
  };
}

async function singleModelSnapshot(
  input: { model: string; refresh: boolean; allowedConnections: readonly string[] },
  providerId: string,
  modelId: string,
  deps: RequiredDeps,
  now: number
): Promise<ModelQuotaResult> {
  const connections = scopedConnectionsForProvider(
    await rawConnections(deps),
    providerId,
    input.allowedConnections,
    deps
  );

  const base = {
    model: { providerID: "omniroute" as const, modelID: input.model },
    resolved: { providerID: providerId, modelID: modelId },
    updatedAt: new Date(now).toISOString(),
  };

  if (connections.length === 0) {
    const supported = supportsProviderQuota(providerId);
    return {
      ok: true,
      snapshot: {
        ...base,
        scope: { type: "upstream-account-plan", providerID: providerId, route: null },
        status: supported ? "unavailable" : "unsupported",
        plan: null,
        windows: [],
      },
    };
  }

  if (connections.length === 1) {
    const evaluated = await evaluateConnection(connections[0], modelId, input.refresh, deps, now);
    return {
      ok: true,
      snapshot: {
        ...base,
        scope: { type: "upstream-account-plan", providerID: providerId, route: null },
        status: aggregateStatus(evaluated.windows, evaluated.supported),
        plan: evaluated.plan,
        windows: evaluated.windows,
      },
    };
  }

  const routes = await evaluateRoutes(
    connections.map((connection) => ({ connection, modelId })),
    input.refresh,
    deps,
    now
  );
  return {
    ok: true,
    snapshot: {
      ...base,
      scope: { type: "aggregate", providerID: providerId, route: null },
      status: aggregateRoutes(routes),
      plan: null,
      windows: [],
      routes,
    },
  };
}

function comboTargets(combo: JsonRecord): string[] {
  const models = Array.isArray(combo.models) ? combo.models : [];
  return dedupeStrings(models.map((entry) => getComboModelString(entry)));
}

export async function buildModelQuotaSnapshot(
  input: ModelQuotaInput,
  deps: ModelQuotaDeps = {}
): Promise<ModelQuotaResult> {
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model || model.length > 512) {
    return {
      ok: false,
      code: "invalid_model",
      message: "A non-empty `model` query parameter (max 512 chars) is required",
    };
  }

  const resolved = await normalizeDeps(deps);
  const now = resolved.now();
  const allowedConnections = dedupeStrings(input.allowedConnections ?? []);
  const refresh = input.refresh === true;

  let combo: JsonRecord | null = null;
  try {
    combo = await resolved.getComboForModel(model);
  } catch {
    combo = null;
  }
  if (combo) {
    return routeSnapshot(
      { model, refresh, allowedConnections },
      typeof combo.name === "string" && combo.name.trim() ? combo.name.trim() : model,
      comboTargets(combo),
      resolved,
      now
    );
  }

  let info: ResolvedModelInfo;
  try {
    info = await resolved.getModelInfo(model);
  } catch (error) {
    return {
      ok: false,
      code: "lookup_failed",
      message: error instanceof Error ? error.message : "Model lookup failed",
    };
  }

  if (info.provider === "auto") {
    return routeSnapshot({ model, refresh, allowedConnections }, model, [], resolved, now);
  }

  if (!info.provider || info.errorType) {
    return {
      ok: false,
      code: "model_not_found",
      message: info.errorMessage || `Model '${model}' is not available`,
    };
  }

  return singleModelSnapshot(
    { model, refresh, allowedConnections },
    info.provider,
    info.model ?? model,
    resolved,
    now
  );
}
