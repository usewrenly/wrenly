import { expect, test } from "bun:test";
import {
  collectWorkspaceDiagnostics,
  searchDiagnosticText,
  MAX_DIAGNOSTIC_CHARACTERS,
} from "../../workspace-diagnostics";
import type { BuildStreamState } from "../../../builds/build-state";
const build: BuildStreamState = {
  buildId: "build-b",
  phase: { name: "success", attempt: 1, buildLog: "" },
  logs: ["Compile succeeded"],
  files: null,
  streamed: false,
};
const preview: Parameters<typeof collectWorkspaceDiagnostics>[1] = {
  buildId: "build-b",
  enabled: true,
  supported: true,
  loading: false,
  error: null,
  url: null,
  activePreview: null,
  preview: {
    id: "preview-b",
    buildId: "build-b",
    status: "preparing",
    log: "Installing preview",
    error: null,
    cleanupPending: false,
  },
};
const publishing: Parameters<typeof collectWorkspaceDiagnostics>[2] = {
  buildId: "build-b",
  enabled: true,
  loading: false,
  error: null,
  deployment: {
    id: "publish-b",
    buildId: "build-b",
    status: "failed",
    url: null,
    errorCode: "READINESS_UNCONFIRMED",
  },
};

test("selected revision fences mismatched snapshot identities and operation output", () => {
  const result = collectWorkspaceDiagnostics(
    build,
    {
      ...preview,
      buildId: "build-a",
      preview: {
        ...preview.preview!,
        buildId: "build-a",
        log: "A private output",
      },
    },
    { ...publishing, buildId: "build-a" },
  );
  expect(result.map((item) => item.status)).toEqual([
    "success",
    "Loading",
    "Loading",
  ]);
  expect(JSON.stringify(result)).not.toContain("A private output");
  expect(JSON.stringify(result)).not.toContain("publish-b");
  const mismatched = collectWorkspaceDiagnostics(
    build,
    { ...preview, preview: { ...preview.preview!, buildId: "build-a" } },
    {
      ...publishing,
      deployment: { ...publishing.deployment!, buildId: "build-a" },
    },
  );
  expect(mismatched.slice(1).every((item) => item.status === "Loading")).toBe(
    true,
  );
  expect(
    collectWorkspaceDiagnostics(
      { ...build, buildId: undefined },
      preview,
      publishing,
    ),
  ).toEqual([]);
});
test("source errors discard stale source output while keeping other diagnostics", () => {
  expect(
    collectWorkspaceDiagnostics(
      {
        ...build,
        phase: {
          name: "failed",
          attempt: 1,
          error: "Connection lost",
          outcomeUnknown: true,
        },
      },
      preview,
      publishing,
    )[0]?.status,
  ).toBe("Outcome unconfirmed");
  const result = collectWorkspaceDiagnostics(
    build,
    { ...preview, error: "Preview read failed" },
    { ...publishing, error: "Publishing read failed" },
  );
  expect(result[0]?.text).toBe("Compile succeeded");
  expect(result[1]?.text).toContain("Preview read failed");
  expect(result[1]?.text).not.toContain("Installing preview");
  expect(result[2]?.operationId).toBeUndefined();
  expect(result[2]?.status).toBe("Unavailable");
});
test("real operations, disabled/missing states and safe publishing errors stay distinct", () => {
  const result = collectWorkspaceDiagnostics(build, preview, publishing);
  expect(result[1]?.operationId).toBe("preview-b");
  expect(result[2]).toMatchObject({
    operationId: "publish-b",
    statusOnly: true,
    status: "failed",
  });
  expect(result[2]?.text).toContain("could not verify its public URL");
  expect(result[2]?.text).toContain("may be running");
  const disabled = collectWorkspaceDiagnostics(
    build,
    { ...preview, enabled: false, preview: null },
    { ...publishing, enabled: false, deployment: null },
  );
  expect(disabled.slice(1).map((item) => item.status)).toEqual([
    "Disabled",
    "Disabled",
  ]);
  expect(
    collectWorkspaceDiagnostics(
      build,
      { ...preview, preview: null },
      { ...publishing, deployment: null },
    )
      .slice(1)
      .map((item) => item.status),
  ).toEqual(["Not started", "Not started"]);
  expect(
    collectWorkspaceDiagnostics(build, preview, {
      ...publishing,
      deployment: { ...publishing.deployment!, errorCode: "RAW_REMOTE_SECRET" },
    })[2]?.text,
  ).not.toContain("RAW_REMOTE_SECRET");
});
test("each source is bounded and a new operation replaces the old identity", () => {
  const result = collectWorkspaceDiagnostics(
    { ...build, logs: ["old-head" + "x".repeat(MAX_DIAGNOSTIC_CHARACTERS)] },
    {
      ...preview,
      preview: { ...preview.preview!, id: "new-preview", log: "new-log" },
    },
    publishing,
  );
  expect(result[0]?.text).toHaveLength(MAX_DIAGNOSTIC_CHARACTERS);
  expect(result[0]?.truncated).toBe(true);
  expect(result[0]?.text).not.toContain("old-head");
  expect(result[1]).toMatchObject({
    operationId: "new-preview",
    text: "new-log",
  });
});
test("plain line search preserves order, whitespace and markup as text", () => {
  expect(
    searchDiagnosticText(
      "  Error: <script>\nunchanged\nERROR again",
      " error ",
    ),
  ).toEqual({ text: "  Error: <script>\nERROR again", lineCount: 2 });
  expect(searchDiagnosticText("retained output", "absent")).toEqual({
    text: "",
    lineCount: 0,
  });
  expect(searchDiagnosticText("", "")).toEqual({ text: "", lineCount: 0 });
  expect(searchDiagnosticText("line one\nline two", "").lineCount).toBe(2);
});
