import { expect, test } from "bun:test";
import { createDatabaseCredentials, DatabaseAction } from "./database-contract";

test("resource roles have separate high-entropy passwords and bounded PostgreSQL identifiers", () => {
  const id = crypto.randomUUID();
  const credentials = createDatabaseCredentials(id);
  const roles = [
    credentials.administrator,
    credentials.migrator,
    credentials.runtime,
    credentials.reader,
  ];
  expect(new Set(roles.map((role) => role.password)).size).toBe(4);
  expect(new Set(roles.map((role) => role.user)).size).toBe(4);
  for (const role of roles) {
    expect(role.user.length).toBeLessThanOrEqual(63);
    expect(role.password).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(createDatabaseCredentials(id).runtime.password).not.toBe(
    credentials.runtime.password,
  );
  expect(() =>
    createDatabaseCredentials("arbitrary-role; DROP DATABASE app"),
  ).toThrow();
});

test("actions bind existing resources and migration reviews without accepting extra commands or secrets", () => {
  const create = {
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    environment: "development",
    kind: "create",
  };
  expect(DatabaseAction.safeParse(create).success).toBe(true);
  expect(
    DatabaseAction.safeParse({
      ...create,
      expectedRevision: crypto.randomUUID(),
    }).success,
  ).toBe(true);
  expect(DatabaseAction.safeParse({ ...create, kind: "start" }).success).toBe(
    false,
  );
  expect(DatabaseAction.safeParse({ ...create, command: "psql" }).success).toBe(
    false,
  );
  expect(
    DatabaseAction.safeParse({ ...create, buildId: crypto.randomUUID() })
      .success,
  ).toBe(false);
  const migrate = {
    ...create,
    kind: "migrate",
    expectedRevision: crypto.randomUUID(),
    buildId: crypto.randomUUID(),
    backupId: crypto.randomUUID(),
    confirmChanges: true,
    migrationDigest: "a".repeat(64),
  };
  expect(DatabaseAction.safeParse(migrate).success).toBe(true);
  expect(
    DatabaseAction.safeParse({ ...migrate, confirmChanges: undefined }).success,
  ).toBe(false);
  expect(
    DatabaseAction.safeParse({ ...migrate, backupId: undefined }).success,
  ).toBe(false);
  expect(
    DatabaseAction.safeParse({ ...migrate, migrationDigest: undefined })
      .success,
  ).toBe(false);
});
