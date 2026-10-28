import { expect, test } from "bun:test";
import { resolveProjectCapabilities } from "../../projects/access/project-access";
import {
  DatabaseViewRequest,
  requireDatabaseViewPermission,
} from "./view-contract";

const base = {
  resourceId: crypto.randomUUID(),
  revision: crypto.randomUUID(),
  environment: "development" as const,
  rows: true,
  table: "reservations",
};
const facts = {
  active: true,
  actorId: "member",
  ownerId: "owner",
  mode: "selected" as const,
  acceptedMember: true,
  instanceRole: "viewer" as const,
};

test("Viewer schema, Development row and Production row permissions stay distinct", () => {
  const viewer = resolveProjectCapabilities({
    ...facts,
    selectedRole: "viewer",
  });
  const editor = resolveProjectCapabilities({
    ...facts,
    selectedRole: "editor",
  });
  const owner = resolveProjectCapabilities({
    ...facts,
    actorId: "owner",
    selectedRole: null,
  });
  expect(() =>
    requireDatabaseViewPermission(viewer, { ...base, rows: false }),
  ).not.toThrow();
  expect(() => requireDatabaseViewPermission(viewer, base)).toThrow(
    "Development",
  );
  expect(() => requireDatabaseViewPermission(editor, base)).not.toThrow();
  expect(() =>
    requireDatabaseViewPermission(editor, {
      ...base,
      environment: "production",
    }),
  ).toThrow("Production");
  expect(() =>
    requireDatabaseViewPermission(owner, {
      ...base,
      environment: "production",
    }),
  ).not.toThrow();
  expect(() => requireDatabaseViewPermission(null, base)).toThrow("not found");
  const archived = resolveProjectCapabilities({
    ...facts,
    actorId: "owner",
    selectedRole: null,
    archived: true,
  });
  expect(() => requireDatabaseViewPermission(archived, base)).toThrow();
});

test("viewer requests reject arbitrary SQL, ambiguous pagination and wrong resource identities", () => {
  expect(DatabaseViewRequest.safeParse(base).success).toBe(true);
  for (const value of [
    { ...base, sql: "DROP TABLE reservations" },
    { ...base, resourceId: "latest" },
    { ...base, revision: "latest" },
    { ...base, environment: "other" },
    { ...base, table: undefined },
    { ...base, rows: false, after: "1" },
    { ...base, table: "x".repeat(64) },
    { ...base, table: "x\0y" },
  ])
    expect(DatabaseViewRequest.safeParse(value).success).toBe(false);
});
