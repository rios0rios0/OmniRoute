import test from "node:test";
import assert from "node:assert/strict";

import {
  buildModelQuotaSnapshot,
  isModelQuotaFailure,
  MODEL_QUOTA_REFRESH_MS,
  MODEL_QUOTA_STALE_MS,
  type ModelQuotaDeps,
} from "../../../src/lib/usage/modelQuota.ts";
import type { ProviderLimitsCacheEntry } from "../../../src/lib/db/providerLimits.ts";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

type CacheOverrides = Partial<ProviderLimitsCacheEntry>;

function cache(overrides: CacheOverrides = {}): ProviderLimitsCacheEntry {
  return {
    quotas: {},
    plan: "Max",
    message: null,
    fetchedAt: iso(-60_000),
    ...overrides,
  };
}

function connections(...entries: Array<Record<string, unknown>>) {
  return async () => entries;
}

function deps(overrides: Partial<ModelQuotaDeps> = {}): ModelQuotaDeps {
  return {
    now: () => NOW,
    getModelInfo: async (model) => ({ provider: "claude", model }),
    getComboForModel: async () => null,
    getProviderConnections: connections({
      id: "conn-claude-1",
      provider: "claude",
      isActive: true,
    }),
    getProviderLimitsCache: () => cache(),
    fetchAndPersistProviderLimits: async () => {
      throw new Error("live refresh not expected in this test");
    },
    getQuotaWindowObservation: () => null,
    getQuotaWindows: (provider) => (provider === "claude" ? ["session", "weekly"] : []),
    resolveProviderAlias: (provider) => provider,
    ...overrides,
  };
}

function snapshotOf(result: Awaited<ReturnType<typeof buildModelQuotaSnapshot>>) {
  assert.equal(result.ok, true);
  if (isModelQuotaFailure(result)) throw new Error("unreachable");
  return result.snapshot;
}

test("contract: canonical 5h/7d/30d windows and a provider-specific window are normalized", async () => {
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "opencode-go/gpt-5.6" },
      deps({
        getModelInfo: async () => ({ provider: "opencode-go", model: "gpt-5.6" }),
        getProviderConnections: connections({
          id: "conn-oc",
          provider: "opencode-go",
          isActive: true,
        }),
        getProviderLimitsCache: () =>
          cache({
            plan: "Go",
            quotas: {
              window_5h: { used: 20, total: 100, remaining: 80, resetAt: iso(3 * 3600_000) },
              window_weekly: { used: 40, total: 200, remaining: 160 },
              window_monthly: { usedPercentage: 60 },
              bonus_window: { used: 5, total: 50 },
            },
          }),
        getQuotaWindows: () => [],
      })
    )
  );

  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.scope.type, "upstream-account-plan");
  assert.equal(snapshot.scope.providerID, "opencode-go");
  assert.deepEqual(snapshot.resolved, { providerID: "opencode-go", modelID: "gpt-5.6" });
  assert.equal(snapshot.plan, "Go");

  const byPeriod = new Map(snapshot.windows.map((window) => [window.period, window]));
  assert.deepEqual([...byPeriod.keys()].sort(), ["30d", "5h", "7d", "bonus_window"]);

  assert.equal(byPeriod.get("5h")?.limit, 100);
  assert.equal(byPeriod.get("5h")?.used, 20);
  assert.equal(byPeriod.get("5h")?.remaining, 80);
  assert.equal(byPeriod.get("5h")?.usedPercentage, 20);
  assert.equal(byPeriod.get("5h")?.status, "available");
  assert.equal(byPeriod.get("5h")?.source, "provider-limits");
  assert.equal(byPeriod.get("7d")?.usedPercentage, 20);
  assert.equal(byPeriod.get("30d")?.usedPercentage, 60);
  assert.equal(byPeriod.get("30d")?.limit, undefined);

  const bonus = byPeriod.get("bonus_window");
  assert.equal(bonus?.period, "bonus_window");
  assert.equal(bonus?.limit, 50);
  assert.equal(bonus?.used, 5);
});

test("partial: windows without any reading stay unavailable while reported ones stay available", async () => {
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "claude/claude-sonnet-4-5" },
      deps({
        getProviderLimitsCache: () => cache({ quotas: { session: { used: 10, total: 100 } } }),
      })
    )
  );

  assert.equal(snapshot.status, "partial");
  const byName = new Map(snapshot.windows.map((window) => [window.windowName, window]));
  assert.equal(byName.get("session")?.status, "available");
  assert.equal(byName.get("weekly")?.status, "unavailable");
  assert.equal(byName.get("weekly")?.usedPercentage, undefined);
  assert.equal(byName.get("weekly")?.limit, undefined);
});

test("unsupported: a provider without a quota surface reports no windows and no guessed limits", async () => {
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "azure-openai/gpt-4o" },
      deps({
        getModelInfo: async () => ({ provider: "azure-openai", model: "gpt-4o" }),
        getProviderConnections: connections({
          id: "conn-azure",
          provider: "azure-openai",
          isActive: true,
        }),
      })
    )
  );

  assert.equal(snapshot.status, "unsupported");
  assert.deepEqual(snapshot.windows, []);
  assert.equal(snapshot.plan, null);
});

test("unavailable: supported provider with no reading and a failing refresh reports unavailable", async () => {
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "claude/claude-sonnet-4-5" },
      deps({
        getProviderLimitsCache: () => null,
        fetchAndPersistProviderLimits: async () => {
          throw new Error("upstream unreachable");
        },
      })
    )
  );

  assert.equal(snapshot.status, "unavailable");
  assert.deepEqual(
    snapshot.windows.map((window) => [window.windowName, window.status]),
    [
      ["session", "unavailable"],
      ["weekly", "unavailable"],
    ]
  );
});

test("stale: an old reading is served with status stale, never as current", async () => {
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "claude/claude-sonnet-4-5" },
      deps({
        getProviderLimitsCache: () =>
          cache({
            fetchedAt: iso(-(MODEL_QUOTA_STALE_MS + 60_000)),
            quotas: { session: { usedPercentage: 42 } },
          }),
        getQuotaWindows: () => ["session"],
        fetchAndPersistProviderLimits: async () => {
          throw new Error("refresh error keeps the last reading");
        },
      })
    )
  );

  assert.equal(snapshot.status, "stale");
  assert.equal(snapshot.windows[0].status, "stale");
  assert.equal(snapshot.windows[0].usedPercentage, 42);
  assert.equal(snapshot.windows[0].observedAt, iso(-(MODEL_QUOTA_STALE_MS + 60_000)));
});

test("refresh: a reading older than the refresh bound triggers one live refresh whose values win", async () => {
  const calls: Array<[string, string]> = [];
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "claude/claude-sonnet-4-5" },
      deps({
        getProviderLimitsCache: () =>
          cache({
            fetchedAt: iso(-(MODEL_QUOTA_REFRESH_MS + 60_000)),
            quotas: { session: { usedPercentage: 90 } },
          }),
        fetchAndPersistProviderLimits: async (connectionId, source) => {
          calls.push([connectionId, source]);
          return {
            cache: cache({ quotas: { session: { usedPercentage: 10 } } }),
          };
        },
      })
    )
  );

  assert.deepEqual(calls, [["conn-claude-1", "manual"]]);
  assert.equal(snapshot.windows[0].usedPercentage, 10);
  assert.equal(snapshot.windows[0].status, "available");
});

test("refresh: a fresh reading is reused without hitting the upstream", async () => {
  let refreshes = 0;
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "claude/claude-sonnet-4-5" },
      deps({
        getProviderLimitsCache: () => cache({ quotas: { session: { usedPercentage: 33 } } }),
        fetchAndPersistProviderLimits: async () => {
          refreshes += 1;
          return {};
        },
      })
    )
  );

  assert.equal(refreshes, 0);
  assert.equal(snapshot.windows[0].usedPercentage, 33);
});

test("refresh=1 forces a live refresh even when the cached reading is fresh", async () => {
  let refreshes = 0;
  await buildModelQuotaSnapshot(
    { model: "claude/claude-sonnet-4-5", refresh: true },
    deps({
      fetchAndPersistProviderLimits: async () => {
        refreshes += 1;
        return {};
      },
    })
  );

  assert.equal(refreshes, 1);
});

test("routing observations fill windows the persisted snapshot does not report", async () => {
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "claude/claude-sonnet-4-5" },
      deps({
        getProviderLimitsCache: () => cache({ quotas: {} }),
        getQuotaWindowObservation: (connectionId, windowName) =>
          connectionId === "conn-claude-1" && windowName === "weekly"
            ? { usedPercentage: 25, resetAt: iso(3600_000), observedAt: iso(-60_000) }
            : null,
      })
    )
  );

  const weekly = snapshot.windows.find((window) => window.windowName === "weekly");
  assert.equal(weekly?.status, "available");
  assert.equal(weekly?.usedPercentage, 25);
  assert.equal(weekly?.remainingPercentage, 75);
  assert.equal(weekly?.source, "routing-observation");
  assert.equal(weekly?.resetsAt, iso(3600_000));
});

test("route: a stored combo reports route scope with its candidate accounts, not one destination", async () => {
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "Coding" },
      deps({
        getComboForModel: async () => ({
          name: "Coding",
          models: [{ model: "claude-sonnet-4-5", providerId: "claude" }, "openai/gpt-5"],
        }),
        getModelInfo: async (model) =>
          model.includes("claude")
            ? { provider: "claude", model: model.replace(/^[^/]+\//, "") }
            : { provider: "openai", model: model.replace(/^openai\//, "") },
        getProviderConnections: connections(
          { id: "conn-claude-1", provider: "claude", isActive: true },
          { id: "conn-openai-1", provider: "openai", isActive: true },
          { id: "conn-gemini-1", provider: "gemini", isActive: true }
        ),
        getProviderLimitsCache: () => cache({ quotas: { session: { usedPercentage: 10 } } }),
      })
    )
  );

  assert.equal(snapshot.scope.type, "route");
  assert.equal(snapshot.scope.route, "Coding");
  assert.equal(snapshot.resolved, null);
  assert.deepEqual(snapshot.windows, []);
  assert.deepEqual(
    snapshot.routes?.map((route) => [route.providerID, route.modelID]),
    [
      ["claude", "claude-sonnet-4-5"],
      ["openai", "gpt-5"],
    ]
  );
});

test("route: an unresolvable candidate is reported as unknown, never attributed to a provider", async () => {
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "Coding" },
      deps({
        getComboForModel: async () => ({ name: "Coding", models: ["mystery/thing"] }),
        getModelInfo: async () => {
          throw new Error("no active catalog entry");
        },
      })
    )
  );

  assert.equal(snapshot.scope.type, "route");
  assert.deepEqual(snapshot.routes, [
    { providerID: null, modelID: "mystery/thing", plan: null, status: "unavailable", windows: [] },
  ]);
  assert.equal(snapshot.status, "unavailable");
});

test("route: a built-in auto combo keeps every active account as an unclaimed candidate", async () => {
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "auto/coding" },
      deps({
        getModelInfo: async () => ({ provider: "auto", model: "coding" }),
        getProviderConnections: connections(
          { id: "conn-claude-1", provider: "claude", isActive: true },
          { id: "conn-oc", provider: "opencode-go", isActive: true }
        ),
        getProviderLimitsCache: () => cache({ quotas: { window_5h: { usedPercentage: 5 } } }),
      })
    )
  );

  assert.equal(snapshot.scope.type, "route");
  assert.equal(snapshot.scope.route, "auto/coding");
  assert.deepEqual(
    snapshot.routes?.map((route) => [route.providerID, route.modelID]),
    [
      ["claude", null],
      ["opencode-go", null],
    ]
  );
});

test("aggregate: several accounts of one provider are listed per account without a single claim", async () => {
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "claude/claude-sonnet-4-5" },
      deps({
        getProviderConnections: connections(
          { id: "conn-claude-1", provider: "claude", isActive: true },
          { id: "conn-claude-2", provider: "claude", isActive: true }
        ),
        getProviderLimitsCache: () =>
          cache({
            quotas: { session: { usedPercentage: 10 }, weekly: { usedPercentage: 20 } },
          }),
      })
    )
  );

  assert.equal(snapshot.scope.type, "aggregate");
  assert.equal(snapshot.windows.length, 0);
  assert.equal(snapshot.routes?.length, 2);
  assert.equal(snapshot.status, "available");
});

test("account isolation: a key never reads connections outside its allowlist", async () => {
  const seen: string[] = [];
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "claude/claude-sonnet-4-5", allowedConnections: ["conn-claude-2"] },
      deps({
        getProviderConnections: connections(
          { id: "conn-claude-1", provider: "claude", isActive: true },
          { id: "conn-claude-2", provider: "claude", isActive: true }
        ),
        getProviderLimitsCache: (connectionId) => {
          seen.push(connectionId);
          return cache({ quotas: { session: { usedPercentage: 70 } } });
        },
      })
    )
  );

  assert.deepEqual(seen, ["conn-claude-2"]);
  assert.equal(snapshot.scope.type, "upstream-account-plan");
  assert.equal(snapshot.windows[0].usedPercentage, 70);
});

test("redaction: the snapshot carries no connection ids or credential material", async () => {
  const snapshot = snapshotOf(
    await buildModelQuotaSnapshot(
      { model: "claude/claude-sonnet-4-5" },
      deps({ getProviderLimitsCache: () => cache({ quotas: { session: { usedPercentage: 1 } } }) })
    )
  );

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("conn-claude-1"), false);
  assert.equal(/api[-_]?key|token|secret|authorization/i.test(serialized), false);
});

test("validation: a missing model is rejected without touching provider state", async () => {
  const result = await buildModelQuotaSnapshot({ model: "   " }, deps());

  assert.equal(result.ok, false);
  if (!isModelQuotaFailure(result)) throw new Error("unreachable");
  assert.equal(result.code, "invalid_model");
});

test("validation: an unknown model surfaces the lookup failure honestly", async () => {
  const result = await buildModelQuotaSnapshot(
    { model: "nope/nothing" },
    deps({
      getModelInfo: async () => ({
        provider: null,
        model: "nothing",
        errorType: "model_not_found",
        errorMessage: "Model 'nope/nothing' is not available",
      }),
    })
  );

  assert.equal(result.ok, false);
  if (!isModelQuotaFailure(result)) throw new Error("unreachable");
  assert.equal(result.code, "model_not_found");
  assert.match(result.message, /not available/);
});
