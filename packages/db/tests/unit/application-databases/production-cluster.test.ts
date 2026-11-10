import { expect, test } from "bun:test";
import {
  createProductionProjectCredentials,
  validateProductionProjectCredentials,
} from "../../../src/application-databases/production-cluster/contract";
test("Production project names and role secrets are distinct and resource-bound", () => {
  const id = crypto.randomUUID(),
    value = createProductionProjectCredentials(id);
  expect(value.database).toBe(`wrenly_${id.replaceAll("-", "")}`);
  expect(
    new Set([
      value.migrator.password,
      value.runtime.password,
      value.reader.password,
    ]).size,
  ).toBe(3);
  expect(validateProductionProjectCredentials(id, value)).toEqual(value);
  expect(() =>
    validateProductionProjectCredentials(crypto.randomUUID(), value),
  ).toThrow();
  expect(() =>
    validateProductionProjectCredentials(id, {
      ...value,
      database: "postgres",
    }),
  ).toThrow();
  expect(() =>
    validateProductionProjectCredentials(id, {
      ...value,
      reader: value.runtime,
    }),
  ).toThrow();
});
