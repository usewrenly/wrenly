import { describe, expect, test } from "bun:test";
import { parseSkillDocument, validateSkillSelection } from "./skill-document";
const skill = (
  header = "name: clear-copy\ndescription: Write clear interface text",
  body = "Use concrete verbs.",
): string => `---\n${header}\n---\n${body}`;
describe("instruction-only SKILL.md import", () => {
  test("preserves exact document and supports standard scalar metadata", () => {
    const input = skill(
      'name: clear-copy\ndescription: "Clear & concise!"\nmetadata:\n  version: "1.0"\nlicense: Apache-2.0',
    );
    const result = parseSkillDocument(input);
    expect(result.document).toBe(input);
    expect(result.metadata).toEqual({ version: "1.0" });
    expect(result.sha256).toHaveLength(64);
    expect(parseSkillDocument(input + "\n").sha256).not.toBe(result.sha256);
  });
  test("supports folded YAML and CRLF without changing provenance hash", () => {
    expect(
      parseSkillDocument(
        skill(
          "name: clear-copy\ndescription: >\n  Use concrete\n  verbs",
        ).replaceAll("\n", "\r\n"),
      ).description,
    ).toContain("Use concrete verbs");
  });
  test.each([
    "name: bad--name\ndescription: Invalid name",
    "name: clear-copy\nname: duplicate\ndescription: Duplicate",
    "name: &name clear-copy\ndescription: *name",
    "name: clear-copy\ndescription: !custom Tagged",
    "name: clear-copy\ndescription: Fine\nallowed-tools: Bash",
    "name: clear-copy\ndescription: Fine\nmetadata:\n  version: 2",
    "name: clear-copy\ndescription: Fine\nmetadata:\n  nested: { key: value }",
  ])("rejects unsupported or ambiguous frontmatter: %s", (header) => {
    expect(() => parseSkillDocument(skill(header))).toThrow();
  });
  test("rejects oversized UTF-8, malformed text, missing body and bundled resources", () => {
    for (const input of [
      skill(undefined, "é".repeat(9000)),
      skill(undefined, ""),
      skill(undefined, "Read [the reference](references/design.md)."),
      skill(undefined, "\ud800"),
      "# no frontmatter",
      skill(undefined, "\0"),
    ])
      expect(() => parseSkillDocument(input)).toThrow();
  });
  test("selection never silently truncates count or byte budget", () => {
    const small = parseSkillDocument(skill());
    expect(() =>
      validateSkillSelection([small, small, small, small]),
    ).not.toThrow();
    expect(() =>
      validateSkillSelection([small, small, small, small, small]),
    ).toThrow();
    const large = parseSkillDocument(skill(undefined, "x".repeat(12000)));
    expect(() => validateSkillSelection([large, large, large])).toThrow();
  });
});
