/** Local NVIDIA NIM RPM quota. NVIDIA exposes no hosted usage endpoint. */
import {
  getProviderDefaultUsage,
  getProviderDefaultRateLimit,
} from "../providerDefaultRateLimit.ts";
import { type UsageQuota } from "./quota.ts";

/** Return the configured provider budget; usage counts are process-local estimates. */
export async function getNvidiaUsage(connectionId: string) {
  const window = getProviderDefaultRateLimit("nvidia");
  if (!window) return { message: "NVIDIA NIM request budget is not configured." };
  const usage = getProviderDefaultUsage("nvidia", connectionId);
  if (!usage) return { message: "NVIDIA NIM request budget is not configured." };

  const quota: UsageQuota = {
    used: usage.used,
    total: window.requests,
    remaining: usage.remaining,
    remainingPercentage: (usage.remaining / window.requests) * 100,
    resetAt: usage.resetAt ? new Date(usage.resetAt).toISOString() : null,
    unlimited: false,
    displayName: `${Math.round(window.windowMs / 60_000)}-minute requests`,
  };

  return {
    quotas: { requests: quota },
    plan: "Local RPM limit",
    message: "NVIDIA NIM has no usage API. Usage shown is this OmniRoute process's local estimate.",
  };
}
