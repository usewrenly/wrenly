import { expect, test } from "bun:test";
import { resolveProjectCapabilities } from "./project-access";
const baseline = {
  active: true,
  actorId: "member",
  ownerId: "creator",
  mode: "private" as const,
  acceptedMember: true,
  selectedRole: null,
  instanceRole: "viewer" as const,
};

test("private ownership is independent of instance administration or membership", () => {
  expect(resolveProjectCapabilities(baseline)).toBeNull();
  expect(
    resolveProjectCapabilities({
      ...baseline,
      actorId: "creator",
      acceptedMember: false,
    }),
  ).toEqual({
    role: "owner",
    read: true,
    contribute: true,
    manage: true,
    publish: true,
  });
  expect(
    resolveProjectCapabilities({
      ...baseline,
      actorId: "creator",
      active: false,
    }),
  ).toBeNull();
});
test("selected grants are scoped, require accepted membership and never authorize owner controls", () => {
  for (const selectedRole of ["viewer", "editor"] as const) {
    expect(
      resolveProjectCapabilities({
        ...baseline,
        mode: "selected",
        selectedRole,
      }),
    ).toEqual({
      role: selectedRole,
      read: true,
      contribute: selectedRole === "editor",
      manage: false,
      publish: false,
    });
    expect(
      resolveProjectCapabilities({
        ...baseline,
        mode: "selected",
        selectedRole,
        acceptedMember: false,
      }),
    ).toBeNull();
    expect(
      resolveProjectCapabilities({
        ...baseline,
        mode: "selected",
        selectedRole,
        active: false,
      }),
    ).toBeNull();
    expect(
      resolveProjectCapabilities({ ...baseline, selectedRole }),
    ).toBeNull();
  }
});
test("instance sharing uses the reviewed common role, never a stale selected grant", () => {
  expect(
    resolveProjectCapabilities({
      ...baseline,
      mode: "instance",
      selectedRole: "editor",
    })?.role,
  ).toBe("viewer");
  expect(
    resolveProjectCapabilities({
      ...baseline,
      mode: "instance",
      instanceRole: "editor",
    })?.contribute,
  ).toBe(true);
  expect(
    resolveProjectCapabilities({
      ...baseline,
      mode: "instance",
      acceptedMember: false,
    }),
  ).toBeNull();
});

test("archived projects retain authorized reads and roles but deny every work/admin capability", () => {
  const owner = resolveProjectCapabilities({
    ...baseline,
    actorId: "creator",
    archived: true,
  });
  expect(owner).toEqual({
    role: "owner",
    read: true,
    contribute: false,
    manage: false,
    publish: false,
  });
  expect(
    resolveProjectCapabilities({
      ...baseline,
      mode: "instance",
      instanceRole: "editor",
      archived: true,
    }),
  ).toEqual({
    role: "editor",
    read: true,
    contribute: false,
    manage: false,
    publish: false,
  });
  expect(
    resolveProjectCapabilities({ ...baseline, archived: true }),
  ).toBeNull();
});
