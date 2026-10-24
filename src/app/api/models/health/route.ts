import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  listModelCatalogHealth,
  upsertModelCatalogHealth,
} from "@/lib/db/modelCatalogHealth";
import { z } from "zod";

const healthResultSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  status: z.enum(["ok", "slow", "error"]),
  latencyMs: z.number().nonnegative().finite().optional(),
  testedAt: z.number().finite().optional(),
  error: z.string().optional(),
  statusCode: z.number().int().optional(),
});

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return Response.json({ results: listModelCatalogHealth() });
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const body = (await request.json().catch(() => null)) as { results?: unknown } | null;
  const results = Array.isArray(body?.results) ? body.results : [];
  let persisted = 0;
  for (const raw of results) {
    const parsed = healthResultSchema.safeParse(raw);
    if (!parsed.success) continue;
    const result = parsed.data;
    upsertModelCatalogHealth({
      providerId: result.providerId,
      modelId: result.modelId,
      status: result.status === "ok" ? "working" : result.status === "slow" ? "slow" : "broken",
      latencyMs: result.latencyMs ?? 0,
      testedAt: result.testedAt ? new Date(result.testedAt).toISOString() : undefined,
      error: result.error ?? null,
      statusCode: result.statusCode ?? null,
      isQuota: false,
      isTransient: false,
      isTimeout: false,
    });
    persisted++;
  }
  return Response.json({ persisted });
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const body = (await request.json().catch(() => ({}))) as {
    providerId?: unknown;
    modelId?: unknown;
  };
  if (typeof body.providerId !== "string" || typeof body.modelId !== "string") {
    return Response.json({ error: "providerId and modelId are required" }, { status: 400 });
  }
  upsertModelCatalogHealth({
    providerId: body.providerId,
    modelId: body.modelId,
    status: "skipped",
    latencyMs: 0,
    error: "Cleared by operator",
    statusCode: null,
    isQuota: false,
    isTransient: false,
    isTimeout: false,
  });
  return Response.json({ ok: true });
}
