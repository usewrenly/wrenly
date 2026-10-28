import { expect, test } from "bun:test";
import { checkDisposableApplicationHttp } from "../../src/databases/application-runtime/runner";
import type { DatabaseRuntimeFence } from "../../src/databases/database-runtime";

test("invalid application checks cannot reach Docker or acquire execution/cleanup effects", async () => {
  const resourceId = crypto.randomUUID();
  let effects = 0;
  const fence: DatabaseRuntimeFence = { assertHeld: async () => { effects++; },
    beforeEffect: async () => { effects++; }, acknowledgeEffect: async () => { effects++; } };
  const input: Parameters<typeof checkDisposableApplicationHttp>[0] = {
    scope: { resourceId, projectId: crypto.randomUUID(), environment: "development" },
    sourceResourceId: crypto.randomUUID(), operationId: resourceId, framework: "nextjs",
    imageId: `sha256:${"a".repeat(64)}`, socket: { id: crypto.randomUUID(), resourceId,
      projectId: "", volumeName: "", containerId: "fixture", imageId: `sha256:${"b".repeat(64)}` },
    role: { user: `wrenly_${resourceId.replaceAll("-", "")}_runtime`, password: "c".repeat(64) },
    bootstrapBundle: new Uint8Array([1]), lifetimeMs: 1000, fence, signal: new AbortController().signal,
    cleanup: { assertHeld: async () => { effects++; }, beforeCleanup: async () => { effects++; },
      acknowledgeCleanup: async () => { effects++; } },
  };
  input.socket.projectId = input.scope.projectId;
  input.socket.volumeName = `wrenly-database-socket-${input.socket.id}`;
  for (const invalid of [
    { ...input, sourceResourceId: resourceId },
    { ...input, operationId: crypto.randomUUID() },
    { ...input, imageId: "mutable:latest" },
    { ...input, lifetimeMs: 60_001 },
    { ...input, bootstrapBundle: new Uint8Array() },
    { ...input, socket: { ...input.socket, volumeName: "other-project" } },
    { ...input, role: { ...input.role, user: input.role.user.replace("_runtime", "_admin") } },
  ]) await expect(checkDisposableApplicationHttp(invalid)).rejects.toThrow("application HTTP check");
  expect(effects).toBe(0);
});
