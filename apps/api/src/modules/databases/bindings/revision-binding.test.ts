import { expect, test } from "bun:test";
import { DatabaseBindingRequest, DatabaseRevisionBinding } from "@wrenly/db/app-database-binding-contract";
const request = { buildId: crypto.randomUUID(), resourceId: crypto.randomUUID(),
  resourceRevision: crypto.randomUUID(), environment: "development" };
test("revision bindings never accept automatic/latest selection, Production or connection credentials", () => {
  expect(DatabaseBindingRequest.safeParse(request).success).toBe(true);
  for (const invalid of [ { ...request, buildId: "latest" }, { ...request, environment: "production" },
    { ...request, resourceRevision: null }, { ...request, password: "PRIVATE" } ])
    expect(DatabaseBindingRequest.safeParse(invalid).success).toBe(false);
  const binding = { ...request, version: 1, projectId: crypto.randomUUID(), accessRevision: crypto.randomUUID(),
    framework: "laravel", migrationOperationId: crypto.randomUUID(), migrationDigest: "a".repeat(64), schemaDigest: "b".repeat(64) };
  expect(DatabaseRevisionBinding.safeParse(binding).success).toBe(true);
  expect(DatabaseRevisionBinding.safeParse({ ...binding, connectionString: "PRIVATE" }).success).toBe(false);
  expect(DatabaseRevisionBinding.safeParse({ ...binding, schemaDigest: "unknown" }).success).toBe(false);
});
