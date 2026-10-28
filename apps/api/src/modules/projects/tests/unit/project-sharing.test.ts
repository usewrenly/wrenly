import { expect, test } from "bun:test";
import { projectAccessNarrows } from "../../sharing/project-sharing";
test("expanding private and selected access never demotes an existing editor", () => {
  const selected = {
    mode: "selected" as const,
    instanceRole: "viewer" as const,
    members: [{ userId: "editor", role: "editor" as const }],
  };
  expect(projectAccessNarrows({ ...selected, mode: "private" }, selected)).toBe(
    false,
  );
  expect(
    projectAccessNarrows(selected, {
      ...selected,
      members: [...selected.members, { userId: "viewer", role: "viewer" }],
    }),
  ).toBe(false);
  expect(
    projectAccessNarrows(selected, {
      ...selected,
      mode: "instance",
      instanceRole: "editor",
      members: [],
    }),
  ).toBe(false);
  expect(
    projectAccessNarrows(selected, {
      ...selected,
      mode: "instance",
      members: [],
    }),
  ).toBe(true);
  expect(projectAccessNarrows(selected, { ...selected, members: [] })).toBe(
    true,
  );
  expect(
    projectAccessNarrows({ ...selected, mode: "instance" }, selected),
  ).toBe(true);
  expect(
    projectAccessNarrows(
      { ...selected, mode: "instance", instanceRole: "editor" },
      { ...selected, mode: "instance" },
    ),
  ).toBe(true);
});
