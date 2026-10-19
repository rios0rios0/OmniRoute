import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import { hasSelfAccountQuotaScope } from "@/shared/constants/selfServiceScopes";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { buildModelQuotaSnapshot, isModelQuotaFailure } from "@/lib/usage/modelQuota";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function error(status: number, code: string, message: string): Response {
  return json(status, buildErrorBody(status, message, null, { code }));
}

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

export const OPTIONS = async (): Promise<Response> => handleCorsOptions();

/**
 * GET /api/v1/quota?model=<model>[&refresh=1]
 *
 * Self-service quota for a selected model: resolves the requested model to the
 * caller's own connections and returns the applicable upstream quota windows
 * (5h/7d/30d when reported, provider-native windows otherwise) with source,
 * freshness, and limit/used/remaining values when the upstream provides them.
 * `auto/*` combos and stored combos keep route-level scope instead of claiming
 * a single upstream destination.
 *
 * Requires an API key with the `self:account-quota` scope; results are scoped
 * to that key's `allowedConnections` (all of its own active connections when
 * the allowlist is empty). `refresh=1` forces a live upstream refresh instead
 * of reusing a reading newer than five minutes.
 */
export async function GET(request: Request): Promise<Response> {
  const apiKey = extractBearerToken(request);
  if (!apiKey) return error(401, "authentication_required", "Authentication required");

  const { validateApiKey, getApiKeyMetadata } = await import("@/lib/db/apiKeys");

  if (!(await validateApiKey(apiKey))) {
    return error(401, "invalid_api_key", "Invalid API key");
  }

  const metadata = await getApiKeyMetadata(apiKey);
  if (!metadata || metadata.id === "env-key") {
    return error(401, "invalid_api_key", "Invalid API key");
  }

  if (!hasSelfAccountQuotaScope(metadata.scopes)) {
    return error(
      403,
      "permission_denied",
      "The self:account-quota scope is required to read upstream account quotas"
    );
  }

  const { searchParams } = new URL(request.url);
  const result = await buildModelQuotaSnapshot({
    model: searchParams.get("model") ?? "",
    refresh: searchParams.get("refresh") === "1",
    allowedConnections: metadata.allowedConnections,
  });

  if (isModelQuotaFailure(result)) {
    if (result.code === "invalid_model") {
      return error(400, "bad_request", result.message);
    }
    if (result.code === "model_not_found") {
      return error(404, "model_not_found", result.message);
    }
    return error(503, "service_unavailable", "Quota resolution is temporarily unavailable");
  }

  return json(200, result.snapshot);
}
