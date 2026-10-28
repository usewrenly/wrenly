import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  validateAppDatabaseCredentials,
  type AppDatabaseCredentials,
} from "../../src/application-databases/roles";
function credentials(id: string): AppDatabaseCredentials {
  const prefix = `wrenly_${id.replaceAll("-", "")}`;
  const role = (suffix: string): { user: string; password: string } => ({
    user: `${prefix}_${suffix}`,
    password: randomBytes(32).toString("hex"),
  });
  return {
    version: 1,
    database: "app",
    administrator: role("admin"),
    migrator: role("migrate"),
    runtime: role("runtime"),
    reader: role("reader"),
  };
}
test("provisioning binds all independently generated roles before connecting", () => {
  const id = crypto.randomUUID(),
    value = credentials(id);
  expect(validateAppDatabaseCredentials(id, value)).toEqual(value);
  expect(() =>
    validateAppDatabaseCredentials(crypto.randomUUID(), value),
  ).toThrow("resource-bound");
  expect(() =>
    validateAppDatabaseCredentials(id, { ...value, database: "wrenly" }),
  ).toThrow();
  expect(() =>
    validateAppDatabaseCredentials(id, { ...value, sql: "grant all" }),
  ).toThrow();
  expect(() =>
    validateAppDatabaseCredentials(id, {
      ...value,
      runtime: value.administrator,
    }),
  ).toThrow();
  expect(() =>
    validateAppDatabaseCredentials(id, {
      ...value,
      reader: { ...value.reader, password: value.runtime.password },
    }),
  ).toThrow();
  expect(() =>
    validateAppDatabaseCredentials(id, {
      ...value,
      migrator: { ...value.migrator, user: "injected; DROP DATABASE app" },
    }),
  ).toThrow();
});
