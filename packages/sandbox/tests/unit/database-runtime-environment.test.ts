import { expect, test } from "bun:test";
import { applicationDatabaseEnvironment } from "../../src/databases/application-runtime/environment";

const resourceId = "101e4567-e89b-12d3-a456-426614174007";
const role = { user: `wrenly_${resourceId.replaceAll("-", "")}_runtime`, password: "a".repeat(64) };

test("application settings select fixed Unix sockets and only runtime credentials", () => {
  const next = applicationDatabaseEnvironment("nextjs", resourceId, role);
  expect(next).toEqual({ PGHOST: "/run/wrenly-database", PGPORT: "6432", PGDATABASE: "app",
    PGUSER: role.user, PGPASSWORD: role.password });
  expect(applicationDatabaseEnvironment("laravel", resourceId, role)).toEqual({
    DB_CONNECTION: "pgsql", DB_HOST: "/run/wrenly-database", DB_PORT: "6432",
    DB_DATABASE: "app", DB_USERNAME: role.user, DB_PASSWORD: role.password,
  });
  expect(Object.isFrozen(next)).toBe(true);
  expect(next.DATABASE_URL).toBeUndefined();
  const changed = { ...role };
  const frozen = applicationDatabaseEnvironment("nextjs", resourceId, changed);
  changed.password = "b".repeat(64);
  expect(frozen.PGPASSWORD).toBe(role.password);
});

test("other roles, resources and malformed secrets are refused without reflecting secrets", () => {
  for (const user of [role.user.replace("_runtime", "_admin"), role.user.replace("_runtime", "_migrate"),
    role.user.replace("_runtime", "_reader"), `wrenly_${"f".repeat(32)}_runtime`]) {
    expect(() => applicationDatabaseEnvironment("nextjs", resourceId, { ...role, user })).toThrow("matching runtime role");
  }
  expect(() => applicationDatabaseEnvironment("nextjs", "../other", role)).toThrow("matching runtime role");
  for (const password of ["secret-value", "a".repeat(64) + "\n", ""]) {
    try {
      applicationDatabaseEnvironment("laravel", resourceId, { ...role, password });
      throw new Error("Expected refusal");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").toBe("Application database settings require the matching runtime role.");
    }
  }
});
