import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IMPORT_LIMITS, IMPORT_LIMIT_PRESETS } from "@wrenly/source-control";
import {
  readConfiguredImportLimits,
  saveConfiguredImportLimits,
} from "../import-limits-store";
import type { db } from "@wrenly/db";

function mockDatabase(ownerId: string | null): typeof db {
  const fake = {
    transaction: async <T>(
      run: (tx: {
        select: () => {
          from: () => {
            innerJoin: () => { where: () => Promise<unknown[]> };
            where: () => {
              for: () => Promise<unknown[]>;
            } & Promise<unknown[]>;
          };
        };
      }) => Promise<T>,
    ): Promise<T> => {
      let queryIndex = 0;
      return run({
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => {
                queryIndex++;
                return Promise.resolve([{ revision: "rev-1" }]);
              },
            }),
            where: () => {
              const current = queryIndex++;
              // Query 0: assertActiveAccount; query 1: readActivePrincipal (innerJoin); query 2: instanceSetup.
              const rows =
                current === 0
                  ? [{ revision: "rev-1", banned: false }]
                  : ownerId
                    ? [{ ownerId }]
                    : [];
              const result = Promise.resolve(rows) as Promise<unknown[]> & {
                for: () => Promise<unknown[]>;
              };
              result.for = () => Promise.resolve(rows);
              return result;
            },
          }),
        }),
      });
    },
  };
  return fake as unknown as typeof db;
}

test("readConfiguredImportLimits falls back cleanly when unset or malformed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wrenly-limits-"));
  try {
    const initial = await readConfiguredImportLimits(dir, DEFAULT_IMPORT_LIMITS);
    expect(initial.preset).toBe("default");
    expect(initial.limits).toEqual(DEFAULT_IMPORT_LIMITS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfiguredImportLimits restricts updates to owner and persists presets and reset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wrenly-limits-"));
  const ownerPrincipal = {
    userId: "owner",
    sessionId: "sess-1",
    revision: "rev-1",
  };
  try {
    await expect(
      saveConfiguredImportLimits(
        mockDatabase("someone-else"),
        dir,
        ownerPrincipal,
        { preset: "large" },
      ),
    ).rejects.toThrow("Only the instance owner");

    const updated = await saveConfiguredImportLimits(
      mockDatabase("owner"),
      dir,
      ownerPrincipal,
      { preset: "unlimited" },
    );
    expect(updated.preset).toBe("unlimited");
    expect(updated.limits).toEqual(IMPORT_LIMIT_PRESETS.unlimited.limits);

    const readBack = await readConfiguredImportLimits(dir, DEFAULT_IMPORT_LIMITS);
    expect(readBack.preset).toBe("unlimited");
    expect(readBack.limits).toEqual(IMPORT_LIMIT_PRESETS.unlimited.limits);

    const resetResult = await saveConfiguredImportLimits(
      mockDatabase("owner"),
      dir,
      ownerPrincipal,
      { reset: true },
    );
    expect(resetResult.preset).toBe("default");
    expect(resetResult.limits).toEqual(IMPORT_LIMIT_PRESETS.default.limits);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
