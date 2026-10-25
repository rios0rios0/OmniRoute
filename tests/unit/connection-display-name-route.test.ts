// PUT /api/providers/[id] accepts and persists `displayName`, the privacy-safe
// account label surfaced as `X-OmniRoute-Connection-Name` on routed responses.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-display-name-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.APP_LOG_TO_FILE = "false";
process.env.JWT_SECRET = "test-jwt-secret-display-name";
process.env.INITIAL_PASSWORD = "admin-secret";

const core = await import("../../src/lib/db/core.ts");
const { createProviderConnection, getProviderConnectionById } =
  await import("../../src/lib/db/providers.ts");
const providerByIdRoute = await import("../../src/app/api/providers/[id]/route.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function createConnection() {
  return (await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI key",
    apiKey: "sk-test-key-value",
    priority: 1,
    isActive: true,
    testStatus: "active",
  })) as Record<string, unknown>;
}

async function patchConnection(id: string, body: Record<string, unknown>) {
  const request = await makeManagementSessionRequest(`http://localhost/api/providers/${id}`, {
    method: "PUT",
    body,
  });
  return providerByIdRoute.PUT(request, { params: Promise.resolve({ id }) });
}

test("PUT persists the configured connection display name", async () => {
  // given
  const connection = await createConnection();

  // when
  const response = await patchConnection(connection.id as string, {
    displayName: "Personal Work Key",
  });

  // then
  assert.equal(response.status, 200);
  const persisted = (await getProviderConnectionById(connection.id as string)) as Record<
    string,
    unknown
  >;
  assert.equal(persisted.displayName, "Personal Work Key");
});

test("PUT clears the connection display name when null is sent", async () => {
  // given
  const connection = await createConnection();
  await patchConnection(connection.id as string, { displayName: "Personal Work Key" });

  // when
  const response = await patchConnection(connection.id as string, { displayName: null });

  // then
  assert.equal(response.status, 200);
  const persisted = (await getProviderConnectionById(connection.id as string)) as Record<
    string,
    unknown
  >;
  // the DB reader strips NULL columns, so an absent label reads back as undefined
  assert.equal(persisted.displayName ?? null, null);
});

test("PUT rejects an overlong connection display name with a 400", async () => {
  // given
  const connection = await createConnection();

  // when
  const response = await patchConnection(connection.id as string, {
    displayName: "x".repeat(201),
  });

  // then
  assert.equal(response.status, 400);
  const persisted = (await getProviderConnectionById(connection.id as string)) as Record<
    string,
    unknown
  >;
  assert.equal(persisted.displayName ?? null, null);
});
