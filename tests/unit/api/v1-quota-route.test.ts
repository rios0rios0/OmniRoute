import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const routePath = path.join(repoRoot, "src/app/api/v1/quota/route.ts");

test("GET /api/v1/quota rejects a missing Bearer token in the handler", async () => {
  const route = await import("../../../src/app/api/v1/quota/route.ts");

  const response = await route.GET(
    new Request("http://localhost/api/v1/quota?model=claude/claude-sonnet-4-5")
  );

  assert.equal(response.status, 401);
  const body = (await response.json()) as { error?: { code?: string; message?: string } };
  assert.equal(body.error?.code, "authentication_required");
  assert.equal(JSON.stringify(body).includes("at /"), false);
});

test("GET /api/v1/quota rejects an unknown API key", async () => {
  const route = await import("../../../src/app/api/v1/quota/route.ts");

  const response = await route.GET(
    new Request("http://localhost/api/v1/quota?model=claude/claude-sonnet-4-5", {
      headers: { authorization: "Bearer definitively-not-a-key" },
    })
  );

  assert.equal(response.status, 401);
});

test("GET /api/v1/quota keeps self-service quota behind the account-quota scope", () => {
  const source = fs.readFileSync(routePath, "utf8");

  assert.match(source, /Authorization/);
  assert.match(source, /Bearer/);
  assert.match(source, /validateApiKey/);
  assert.match(source, /getApiKeyMetadata/);
  assert.match(source, /metadata\.id === "env-key"/);
  assert.match(source, /hasSelfAccountQuotaScope/);
  assert.match(source, /self:account-quota/);
  assert.match(source, /searchParams\.get\("model"\)/);
  assert.match(source, /searchParams\.get\("refresh"\)/);
  assert.match(source, /allowedConnections: metadata\.allowedConnections/);
  assert.doesNotMatch(source, /searchParams\.get\(["']apiKeyId["']\)/);
});

test("OPTIONS /api/v1/quota answers the CORS preflight", async () => {
  const route = await import("../../../src/app/api/v1/quota/route.ts");

  const response = await route.OPTIONS();

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Methods")?.includes("GET"), true);
});
