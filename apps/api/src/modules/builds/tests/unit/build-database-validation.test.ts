import { expect, test } from "bun:test";
import type { db } from "@wrenly/db";
import type { BuildClaim } from "../../persistence/build-job-store";
import { createDatabaseBuildValidator } from "../../../databases/validation/build-validator";
import { databaseBuildGuidance } from "../../../databases/validation/build-guidance";
import { BuildExecutionInterruptedError } from "../../execution/build-interruption";
import { appDatabaseSource } from "../../../../../../../packages/db/tests/fixtures/app-database-source";

// Every storage/execution operation is injected here; this object never opens a connection.
const database = {} as typeof db;
const signal = new AbortController().signal;
function claim(framework: "nextjs" | "laravel", selected = true): BuildClaim {
  return {
    projectId: crypto.randomUUID(),
    buildId: crypto.randomUUID(),
    token: crypto.randomUUID(),
    input: {
      prompt: "Build",
      stack: framework,
      provider: "fixture",
      model: "fixture",
      previousFiles: [],
      previousErrors: [],
      ...(selected
        ? {
            databaseV1: {
              version: 1 as const,
              environment: "development" as const,
              resourceId: crypto.randomUUID(),
              resourceRevision: crypto.randomUUID(),
            },
          }
        : {}),
    },
  };
}

test("database mentions do not select a resource or bypass stateless validation", async () => {
  let calls = 0;
  const validate = createDatabaseBuildValidator(
    database,
    async () => {
      calls++;
      return { success: false, output: "Stateless guard" };
    },
    async () => {
      throw new Error("Must not execute");
    },
  );
  expect(
    await validate(
      appDatabaseSource("nextjs"),
      claim("nextjs", false),
      signal,
      1,
    ),
  ).toEqual({ success: false, output: "Stateless guard" });
  expect(calls).toBe(1);
  expect(databaseBuildGuidance("nextjs", undefined)).toBe("");
});

for (const framework of ["nextjs", "laravel"] as const)
  test(`selected ${framework} validation distinguishes repairable source from interrupted work`, async () => {
    let calls = 0;
    const parent = claim(framework);
    const validate = createDatabaseBuildValidator(
      database,
      async () => {
        throw new Error("Wrong path");
      },
      async (_db, owned, selection) => {
        calls++;
        expect(owned).toBe(parent);
        expect(selection).toMatchObject({
          resourceId: parent.input.databaseV1!.resourceId,
          resourceRevision: parent.input.databaseV1!.resourceRevision,
        });
        expect(JSON.stringify(selection)).not.toContain("files");
        expect(JSON.stringify(selection)).not.toContain("actorId");
        return {
          operationId: crypto.randomUUID(),
          outcome: {
            status: "success",
            result: {
              migrationDigest: "a".repeat(64),
              schemaDigest: "b".repeat(64),
              httpReady: true,
            },
          },
        };
      },
    );
    expect(
      (
        await validate(
          [{ path: "package.json", content: "{}" }],
          parent,
          signal,
          1,
        )
      ).success,
    ).toBe(false);
    expect(calls).toBe(0);
    expect(
      (await validate(appDatabaseSource(framework), parent, signal, 1)).success,
    ).toBe(true);
    expect(calls).toBe(1);
    const interrupted = createDatabaseBuildValidator(
      database,
      validate,
      async () => ({
        operationId: crypto.randomUUID(),
        outcome: { status: "interrupted" },
      }),
    );
    await expect(
      interrupted(appDatabaseSource(framework), parent, signal, 1),
    ).rejects.toBeInstanceOf(BuildExecutionInterruptedError);
    const failed = createDatabaseBuildValidator(
      database,
      validate,
      async () => ({
        operationId: crypto.randomUUID(),
        outcome: { status: "failed", diagnostics: "Type error: fixture needs title" },
      }),
    );
    expect(
      (await failed(appDatabaseSource(framework), parent, signal, 1)).success,
    ).toBe(false);
    expect((await failed(appDatabaseSource(framework), parent, signal, 1)).output).toContain("Type error: fixture needs title");
    const guidance = databaseBuildGuidance(framework, parent.input.databaseV1);
    expect(guidance).toContain("wrenly.app.json");
    expect(guidance).toContain(
      framework === "laravel" ? "DB_PASSWORD" : "PGPASSWORD",
    );
    expect(guidance).not.toContain(parent.input.databaseV1!.resourceId);
  });


test("inactive production execution fences a saved database job before any model or validator call", async () => {
  const { createBuildWorkerDependencies } = await import("../../execution/build-worker-services");
  let called = false;
  const dependencies = createBuildWorkerDependencies(database, {
    databaseValidation: false,
    generate: async () => { called = true; throw new Error("Must not generate"); },
    validate: async () => { called = true; throw new Error("Must not validate"); },
    cleanup: async () => {},
  });
  await expect(dependencies.execute(claim("nextjs"), signal)).rejects.toBeInstanceOf(BuildExecutionInterruptedError);
  expect(called).toBe(false);
});

test("invalid generated journals return a precise trusted repair reason before any database work", async () => {
  let executed = false;
  const validate = createDatabaseBuildValidator(database, async () => { throw new Error("No stateless fallback"); }, async () => { executed = true; throw new Error("Must not execute"); });
  const files = appDatabaseSource("nextjs").map(file => file.path === "drizzle/meta/_journal.json" ? { ...file, content: JSON.stringify({ dialect: "postgresql", entries: [] }) } : file);
  const result = await validate(files, claim("nextjs"), signal, 1);
  expect(result.success).toBe(false);
  expect(result.error).toContain("Drizzle journal must match");
  expect(executed).toBe(false);
  const guidance = databaseBuildGuidance("nextjs", claim("nextjs").input.databaseV1);
  expect(guidance).toContain('"tag":"0000_initial"');
  expect(guidance).toContain('"migrations":["drizzle/0000_initial.sql"]');
});

test("managed connection fallback fails before disposable execution and yields a repairable source error", async () => {
  let executions = 0;
  const validate = createDatabaseBuildValidator(database, async () => { throw new Error("No stateless fallback"); }, async () => {
    executions++;
    return { operationId: crypto.randomUUID(), outcome: { status: "failed" } };
  });
  const files = [...appDatabaseSource("nextjs"), { path: "db/index.ts", content: "import postgres from 'postgres'; const sql=postgres(process.env.DATABASE_URL || 'postgres://fixture:fixture@localhost/db');" }];
  const result = await validate(files, claim("nextjs"), signal, 1);
  expect(result.success).toBe(false);
  expect(result.error).toContain("not DATABASE_URL");
  expect(executions).toBe(0);
  await validate(files.map(file => file.path === "db/index.ts" ? { ...file, content: "import postgres from 'postgres'; const sql=postgres();" } : file), claim("nextjs"), signal, 2);
  expect(executions).toBe(1);
});
