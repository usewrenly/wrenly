import { describe, expect, test } from "bun:test";
import { acquireDatabaseExecutorLock } from "./database-executor-lock";
const integration =
  process.env.WRENLY_TEST_DATABASE_LOCKS === "true" ? describe : describe.skip;
integration("database resource kernel lock", () => {
  test("different operations for the same resource cannot overlap; release permits recovery", async () => {
    const claim = {
      id: crypto.randomUUID(),
      resourceId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      token: crypto.randomUUID(),
    };
    const first = await acquireDatabaseExecutorLock(claim);
    try {
      first.assertHeld();
      await expect(
        acquireDatabaseExecutorLock({
          ...claim,
          id: crypto.randomUUID(),
          token: crypto.randomUUID(),
        }),
      ).rejects.toThrow("still active");
      const other = await acquireDatabaseExecutorLock({
        ...claim,
        resourceId: crypto.randomUUID(),
      });
      await other.release();
    } finally {
      await first.release();
    }
    await first.release();
    expect(() => first.assertHeld()).toThrow("no longer held");
    const recovery = await acquireDatabaseExecutorLock({
      ...claim,
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
    });
    await recovery.release();
  });
});
