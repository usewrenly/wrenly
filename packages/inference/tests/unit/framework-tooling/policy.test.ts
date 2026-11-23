import { expect, test } from "bun:test";
import {
  frameworkInspectionRequest,
  supportsFrameworkInspection,
  assertNoArgumentErrorTool,
} from "../../../src/framework-tooling/policy";
test("installed stable framework versions qualify without silently upgrading older apps", () => {
  expect(supportsFrameworkInspection("laravel", "13.0.0")).toBe(true);
  expect(supportsFrameworkInspection("nextjs", "16.4.3")).toBe(true);
  for (const version of [
    "15.5.28",
    "^16.0.0",
    "16.0.0-canary.1",
    "17.0.0",
    "16",
    "../../16.0.0",
  ]) {
    expect(supportsFrameworkInspection("nextjs", version)).toBe(false);
    expect(() => frameworkInspectionRequest("nextjs", version)).toThrow();
  }
  expect(supportsFrameworkInspection("laravel", "12.0.0")).toBe(false);
});
test("requests cannot select execution tools, database access or a foreign development port", () => {
  expect(frameworkInspectionRequest("laravel", "13.0.0")).toEqual({
    method: "resources/read",
    params: { uri: "file://instructions/application-info.md" },
  });
  expect(frameworkInspectionRequest("nextjs", "16.4.3")).toEqual({
    method: "tools/call",
    params: {
      name: "nextjs_call",
      arguments: { port: 3000, toolName: "get_errors" },
    },
  });
});
test("changed tool schemas fail closed before invocation", () => {
  expect(() =>
    assertNoArgumentErrorTool({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    }),
  ).not.toThrow();
  for (const schema of [
    null,
    [],
    { type: "string" },
    { type: "object", properties: { command: { type: "string" } } },
    { type: "object", required: ["port"] },
    { type: "object", additionalProperties: true },
    { type: "object", oneOf: [] },
    { type: "object", $schema: "https://untrusted.example/schema" },
  ]) {
    expect(() => assertNoArgumentErrorTool(schema)).toThrow();
  }
});
