import { expect, test } from "bun:test";
import { createDatabaseMigrationReviewHandler } from "./migration-review";
import { createDatabaseRecoveryReviewHandler } from "./recovery-review";
const projectId = crypto.randomUUID(), resourceId = crypto.randomUUID(), buildId = crypto.randomUUID(), operationId = crypto.randomUUID();
const review = { projectId, resourceId, buildId, revision: crypto.randomUUID(), framework: "laravel", migrationDigest: "a".repeat(64),
  files: [{ path: "database/migrations/notes.php", sha256: "b".repeat(64), content: "<?php // reviewed" }], backups: [] };
const url = `http://localhost/api/projects/${projectId}/databases/migration-review?resourceId=${resourceId}&buildId=${buildId}`;
test("review returns selected bounded source and private no-store metadata without executing", async () => {
  let reads = 0;
  const handler = createDatabaseMigrationReviewHandler({ userId: async () => "owner", read: async (project, actor, resource, build) => {
    reads++; expect([project, actor, resource, build]).toEqual([projectId, "owner", resourceId, buildId]); return review;
  } });
  const response = await handler(new Request(url), projectId);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual(review); expect(reads).toBe(1);
});
test("invalid, duplicate, denied and changed-session reviews cannot expose saved source", async () => {
  let reads = 0;
  const services = { userId: async (): Promise<string | null> => "owner", read: async (): Promise<unknown> => { reads++; return review; } };
  const handler = createDatabaseMigrationReviewHandler(services);
  for (const suffix of ["&buildId=" + buildId, "&unknown=true"])
    expect((await handler(new Request(url + suffix), projectId)).status).toBe(400);
  expect(reads).toBe(0);
  const denied = createDatabaseMigrationReviewHandler({ ...services, userId: async () => null });
  expect((await denied(new Request(url), projectId)).status).toBe(401);
  let sessions = 0;
  const expired = createDatabaseMigrationReviewHandler({ ...services, userId: async () => ++sessions === 1 ? "owner" : null });
  expect((await expired(new Request(url), projectId)).status).toBe(401);
  for (const value of [{ ...review, projectId: crypto.randomUUID() }, { ...review, credentials: "PRIVATE" },
    { ...review, files: [review.files[0], review.files[0]] }]) {
    const unsafe = createDatabaseMigrationReviewHandler({ ...services, read: async () => value });
    const response = await unsafe(new Request(url), projectId);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("PRIVATE");
  }
});
test("recovery review is explicit, bounded and rejects foreign operation identities", async () => {
  const value = { projectId, resourceId, operationId, revision: review.revision, choices: ["recover-runtime-state"] };
  const request = new Request(`http://localhost/recovery-review?resourceId=${resourceId}&operationId=${operationId}`);
  const handler = createDatabaseRecoveryReviewHandler({ userId: async () => "owner", read: async () => value });
  expect((await handler(request, projectId)).status).toBe(200);
  const wrong = createDatabaseRecoveryReviewHandler({ userId: async () => "owner", read: async () => ({ ...value, operationId: crypto.randomUUID() }) });
  expect((await wrong(request, projectId)).status).toBe(503);
});
