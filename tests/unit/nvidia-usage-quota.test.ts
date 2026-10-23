import test from "node:test";
import assert from "node:assert/strict";

import {
  __setProviderDefaultRateLimitsForTests,
  acquireProviderDefaultSlot,
} from "../../open-sse/services/providerDefaultRateLimit.ts";
import { getUsageForProvider, USAGE_FETCHER_PROVIDERS } from "../../open-sse/services/usage.ts";
import { USAGE_SUPPORTED_PROVIDERS } from "../../open-sse/services/usage/supportedProviders.ts";

test.afterEach(() => {
  __setProviderDefaultRateLimitsForTests(null);
});

test("NVIDIA NIM exposes current local request-window usage", async () => {
  // given
  __setProviderDefaultRateLimitsForTests({ nvidia: { requests: 40, windowMs: 60_000 } });
  acquireProviderDefaultSlot("nvidia", "nvidia-connection");

  // when
  const result = (await getUsageForProvider({
    id: "nvidia-connection",
    provider: "nvidia",
    apiKey: "fixture-token-placeholder",
  })) as { quotas?: Record<string, { used: number; total: number; remaining: number }> };

  // then
  assert.ok(USAGE_FETCHER_PROVIDERS.includes("nvidia"));
  assert.ok(USAGE_SUPPORTED_PROVIDERS.includes("nvidia"));
  assert.equal(result.quotas?.requests.used, 1);
  assert.equal(result.quotas?.requests.total, 40);
  assert.equal(result.quotas?.requests.remaining, 39);
});
