// Selects revision-matched recorded output; this projection starts no requests or work.
import type { BuildStreamState } from "../builds/build-state";
import type { useLocalPreview } from "@/hooks/use-local-preview";
import type { useDeployment } from "@/hooks/use-deployment";
import { PUBLISHING_ERRORS } from "../publishing-errors";

export const MAX_DIAGNOSTIC_CHARACTERS = 256_000;
export type DiagnosticSourceId = "build" | "preview" | "publishing";
export interface DiagnosticSource {
  id: DiagnosticSourceId;
  label: string;
  status: string;
  operationId?: string;
  statusOnly: boolean;
  text: string;
  truncated: boolean;
}
type PreviewState = ReturnType<typeof useLocalPreview>["state"];
type PublishingState = ReturnType<typeof useDeployment>["state"];
function source(
  id: DiagnosticSourceId,
  label: string,
  status: string,
  text: string,
  operationId?: string,
): DiagnosticSource {
  return {
    id,
    label,
    status,
    text: text.slice(-MAX_DIAGNOSTIC_CHARACTERS),
    operationId,
    statusOnly: id === "publishing",
    truncated: text.length > MAX_DIAGNOSTIC_CHARACTERS,
  };
}
/** Projects only matching revision snapshots; stale/error states never masquerade as current output. */
export function collectWorkspaceDiagnostics(
  build: BuildStreamState,
  preview: PreviewState,
  publishing: PublishingState,
): DiagnosticSource[] {
  const buildId = build.buildId;
  if (!buildId) return [];
  let buildText = build.logs.join("\n");
  if (build.phase.name === "failed" && !buildText.includes(build.phase.error))
    buildText += `${buildText ? "\n" : ""}${build.phase.error}`;
  const buildSource = source(
    "build",
    "Build",
    build.phase.name === "failed" && build.phase.outcomeUnknown
      ? "Outcome unconfirmed"
      : build.phase.name,
    buildText || "No build output has been recorded yet.",
    buildId,
  );
  let previewSource: DiagnosticSource;
  if (build.phase.name !== "success")
    previewSource = source(
      "preview",
      "Preview",
      "Not available",
      "A successful build is needed for local preview.",
    );
  else if (
    preview.buildId !== buildId ||
    (preview.preview && preview.preview.buildId !== buildId) ||
    preview.loading
  )
    previewSource = source(
      "preview",
      "Preview",
      "Loading",
      "Reading preview diagnostics for the selected revision…",
    );
  else if (preview.error)
    previewSource = source(
      "preview",
      "Preview",
      "Unavailable",
      `Preview diagnostics could not be refreshed.\n${preview.error}`,
    );
  else if (!preview.enabled)
    previewSource = source(
      "preview",
      "Preview",
      "Disabled",
      "Local previews are disabled in this instance's configuration.",
    );
  else if (!preview.supported)
    previewSource = source(
      "preview",
      "Preview",
      "Unsupported",
      "Local preview is not supported for this framework.",
    );
  else if (!preview.preview)
    previewSource = source(
      "preview",
      "Preview",
      "Not started",
      "No preview has been prepared for this revision.",
    );
  else {
    const operation = preview.preview;
    const text = [operation.log, operation.error].filter(Boolean).join("\n");
    previewSource = source(
      "preview",
      "Preview",
      operation.status,
      text || "No output has been recorded for this preview operation yet.",
      operation.id,
    );
  }
  let publishingSource: DiagnosticSource;
  if (
    publishing.buildId !== buildId ||
    (publishing.deployment && publishing.deployment.buildId !== buildId) ||
    publishing.loading
  )
    publishingSource = source(
      "publishing",
      "Publishing",
      "Loading",
      "Reading publishing status for the selected revision…",
    );
  else if (publishing.error)
    publishingSource = source(
      "publishing",
      "Publishing",
      "Unavailable",
      `Publishing status could not be refreshed.\n${publishing.error}`,
    );
  else if (publishing.deployment) {
    const operation = publishing.deployment;
    const explanation = operation.errorCode
      ? (PUBLISHING_ERRORS[operation.errorCode] ??
        "Publishing did not complete. Review its operation status.")
      : "";
    publishingSource = source(
      "publishing",
      "Publishing",
      operation.status,
      `Publishing status: ${operation.status}.${explanation ? `\n${explanation}` : ""}${publishing.enabled ? "" : "\nNew publishing is disabled in configuration."}`,
      operation.id,
    );
  } else
    publishingSource = source(
      "publishing",
      "Publishing",
      publishing.enabled ? "Not started" : "Disabled",
      publishing.enabled
        ? "No publishing operation has been recorded for this revision."
        : "Publishing is disabled in this instance's configuration.",
    );
  return [buildSource, previewSource, publishingSource];
}
/** Searches plain recorded text without parsing markup, timestamps, severity or commands. */
export function searchDiagnosticText(
  text: string,
  search: string,
): { text: string; lineCount: number } {
  const query = search.trim().toLocaleLowerCase();
  const lines = text ? text.split("\n") : [];
  const matches = query
    ? lines.filter((line) => line.toLocaleLowerCase().includes(query))
    : lines;
  return { text: matches.join("\n"), lineCount: matches.length };
}
