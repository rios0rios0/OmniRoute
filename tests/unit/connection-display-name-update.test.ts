import test from "node:test";
import assert from "node:assert/strict";

import { updateProviderConnectionSchema } from "@/shared/validation/schemas/provider";

test("updateProviderConnectionSchema accepts a privacy-safe display name", () => {
  // given / when
  const result = updateProviderConnectionSchema.safeParse({ displayName: "OpenRouter Free" });

  // then
  assert.equal(result.success, true);
});

test("updateProviderConnectionSchema accepts null to clear the display name", () => {
  // given / when
  const result = updateProviderConnectionSchema.safeParse({ displayName: null });

  // then
  assert.equal(result.success, true);
});

test("updateProviderConnectionSchema rejects an overlong display name", () => {
  // given / when
  const result = updateProviderConnectionSchema.safeParse({ displayName: "x".repeat(201) });

  // then
  assert.equal(result.success, false);
});
