import { expect, test } from "bun:test";
import { SkillCreate, SkillChange } from "./skill-contract";
const content = {
  requestId: crypto.randomUUID(),
  skillId: crypto.randomUUID(),
  document: "reviewed",
  source: "imported",
  sourceUrl: null,
  versionLabel: null,
  licenseNotes: "",
};
test("skill provenance never accepts credential-bearing or automatic-fetch configuration", () => {
  expect(
    SkillCreate.safeParse({
      ...content,
      sourceUrl: "https://example.test/skills",
    }).success,
  ).toBe(true);
  for (const sourceUrl of [
    "https://user:password@example.test/skills",
    "https://example.test/?token=secret",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a URL",
    "https://",
    "",
  ])
    expect(SkillCreate.safeParse({ ...content, sourceUrl }).success).toBe(
      false,
    );
  expect(
    SkillCreate.safeParse({ ...content, ownerId: "somebody-else" }).success,
  ).toBe(false);
  expect(
    SkillCreate.safeParse({ ...content, scripts: ["install.sh"] }).success,
  ).toBe(false);
});
test("skill archive requests cannot smuggle content or client-chosen current versions", () => {
  const archive = {
    kind: "archive",
    requestId: crypto.randomUUID(),
    expectedRevision: crypto.randomUUID(),
    archived: true,
  };
  expect(SkillChange.safeParse(archive).success).toBe(true);
  expect(
    SkillChange.safeParse({ ...archive, document: "replacement" }).success,
  ).toBe(false);
  expect(
    SkillChange.safeParse({ ...archive, currentVersionId: crypto.randomUUID() })
      .success,
  ).toBe(false);
});
