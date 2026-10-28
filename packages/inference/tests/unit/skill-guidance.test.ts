import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  parseSkillGuidance,
  skillGuidanceMessage,
} from "../../src/guidance/skill-guidance";
function fixture(document = "Instructions only"): unknown {
  return {
    version: 1,
    skills: [
      {
        skillId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        name: "team-style",
        description: "Team style",
        document,
        sha256: createHash("sha256").update(document).digest("hex"),
        source: "authored",
        sourceUrl: null,
        versionLabel: null,
        licenseNotes: "",
      },
    ],
  };
}
test("guidance is bounded, hash-verified and independent of mutable inputs", () => {
  const parsed = parseSkillGuidance(fixture());
  expect(parseSkillGuidance(undefined).skills).toEqual([]);
  expect(
    parseSkillGuidance({
      version: 1,
      skills: [
        {
          ...parsed.skills[0],
          skillId: "00000000-0000-0000-0000-000000000000",
        },
      ],
    }).skills,
  ).toHaveLength(1);
  expect(skillGuidanceMessage(parsed)).toContain("untrusted instructions");
  expect(() => parseSkillGuidance({ ...parsed, version: 2 })).toThrow();
  expect(() => parseSkillGuidance({ ...parsed, tools: ["Bash"] })).toThrow();
  expect(() =>
    parseSkillGuidance({
      version: 1,
      skills: [{ ...parsed.skills[0], document: "tampered" }],
    }),
  ).toThrow();
  expect(() =>
    parseSkillGuidance({
      version: 1,
      skills: [parsed.skills[0], parsed.skills[0]],
    }),
  ).toThrow();
  expect(() => parseSkillGuidance(fixture("é".repeat(9000)))).toThrow();
});
