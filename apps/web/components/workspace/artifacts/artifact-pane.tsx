"use client";
//
// ArtifactPane — selected-build local preview, generated code and build diagnostics.
// Published URLs are separate from claim-owned previews.

import { DocumentationLink } from "@/components/documentation-link";
import { Popover } from "@base-ui/react/popover";
import { useDeployment } from "@/hooks/use-deployment";
import { useLocalPreview } from "@/hooks/use-local-preview";

import { useEffect, useRef, useState } from "react";
import type { BuildStreamState } from "@/hooks/use-build-stream";
import {
  ArrowUpRightIcon,
  InfoIcon,
  RefreshCwIcon,
  FileJson,
  FileCode,
  Palette,
  FileText,
  File,
  PanelsTopLeftIcon,
  SmartphoneIcon,
  TabletIcon,
  MonitorIcon,
  CodeIcon,
  TerminalIcon,
  DatabaseIcon,
} from "lucide-react";
import { SourceDownload } from "./source-download";
import { CodeEditor } from "./code-editor";

import { PUBLISHING_ERRORS } from "@/lib/publishing-errors";
import { WorkspaceLogs } from "./workspace-logs";
import { collectWorkspaceDiagnostics } from "@/lib/diagnostics/workspace-diagnostics";

const PREVIEW_HELP = {
  queued: "Waiting for a preview slot. You can keep working in the conversation.",
  preparing: "Preparing dependencies and validating this saved app in isolation.",
  starting: "Starting your app and waiting for it to respond.",
  ready: "Opening access to this revision. Refresh preview if its access has expired.",
  expired: "This preview has expired. Prepare this revision again to reopen it.",
  stopped: "Prepare this revision again to reopen it. Your saved source is preserved.",
  failed: "Preparation failed. Check preview output below before trying again.",
  interrupted: "Preparation was interrupted. Review output and cleanup before preparing again.",
};

type Tab = "preview" | "code" | "logs" | "database";

export function FileIcon({ path }: { path: string }): React.JSX.Element {
  if (path.endsWith(".json"))
    return <FileJson size={14} className="text-yellow-500 shrink-0" />;
  if (path.endsWith(".tsx") || path.endsWith(".ts"))
    return <FileCode size={14} className="text-sky-500 shrink-0" />;
  if (path.endsWith(".css"))
    return <Palette size={14} className="text-pink-400 shrink-0" />;
  if (path.endsWith(".md"))
    return <FileText size={14} className="text-zinc-400 shrink-0" />;
  return <File size={14} className="text-zinc-400 shrink-0" />;
}

interface ArtifactPaneProps {
  mediaRevision?: string | null;
  databasePane?: React.ReactNode;
  canContribute?: boolean;
  canPublish?: boolean;
  state: BuildStreamState;
  projectId: string;
  liveUrl: string | null;
  tab?: Tab;
  onTabChange?: (tab: Tab) => void;
  onDeployed: (url: string) => void;
}

export function ArtifactPane({
  state,
  databasePane,
  mediaRevision,
  canContribute = true,
  canPublish = true,
  projectId,
  liveUrl,
  onDeployed,
  tab: controlledTab,
  onTabChange,
}: ArtifactPaneProps): React.JSX.Element {
  const [viewport, setViewport] = useState<"desktop" | "tablet" | "mobile">(
    "desktop",
  );
  const local = useLocalPreview(
    state.buildId,
    state.phase.name === "success",
    mediaRevision,
  );
  const [localTab, setLocalTab] = useState<Tab>("preview");
  const requestedTab = controlledTab ?? localTab;
  const tab = requestedTab === "database" && !databasePane ? "preview" : requestedTab;
  const setTab = (next: Tab): void => {
    setLocalTab(next);
    onTabChange?.(next);
  };
  const previousTab = useRef(tab);
  useEffect(() => {
    if (tab === "preview" && previousTab.current !== "preview") local.reload();
    previousTab.current = tab;
  }, [tab, local.reload]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const publishing = useDeployment(projectId, state.buildId);
  const reportedUrl = useRef<string | null>(null);
  useEffect(() => {
    const url =
      publishing.state.deployment?.status === "success"
        ? publishing.state.deployment.url
        : null;
    if (url && url !== reportedUrl.current) {
      reportedUrl.current = url;
      onDeployed(url);
    }
  }, [publishing.state.deployment, onDeployed]);

  const files = state.files;
  const phase = state.phase;
  const previewTitle = !state.buildId
    ? "Select a revision to preview"
    : phase.name !== "success"
      ? "A validated build comes first"
      : local.state.loading
        ? "Checking this revision’s preview"
        : local.state.error
          ? "Preview needs attention"
          : !local.state.enabled
            ? "Local preview is disabled"
            : !local.state.supported
              ? "Preview is unavailable for this framework"
              : local.state.preview
                ? local.state.preview.status === "ready"
                  ? "Opening the isolated preview"
                  : `Preview ${local.state.preview.status}`
                : "See your work take shape";

  const selected = Math.max(
    0,
    files?.findIndex((file) => file.path === selectedPath) ?? 0,
  );

  const tabs: Array<{ id: Tab; label: string; badge?: string }> = [
    { id: "preview", label: "Preview" },
    {
      id: "code",
      label: "Code",
      badge: files ? String(files.length) : undefined,
    },
    {
      id: "logs",
      label: "Logs",
      badge: state.logs.length ? String(state.logs.length) : undefined,
    },
    ...(databasePane ? [{ id: "database" as const, label: "Database", badge: "Experimental" }] : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Artifact views"
        className="workspace-artifact-tabs flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-3"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`${projectId}-artifact-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${projectId}-artifact-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? tabs[0]!
                  : event.key === "End"
                    ? tabs[tabs.length - 1]!
                    : tabs[
                        (tabs.findIndex((item) => item.id === tab) +
                          (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                          tabs.length
                      ]!;
              setTab(next.id);
              document
                .getElementById(`${projectId}-artifact-${next.id}`)
                ?.focus();
            }}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
              tab === t.id
                ? "bg-[var(--color-surface)] text-[var(--color-text-1)] shadow-[var(--shadow-sm)]"
                : "text-[var(--color-text-3)] hover:text-[var(--color-text-2)]"
            }`}
          >
            {t.id === "preview" ? (
              <PanelsTopLeftIcon size={14} aria-hidden="true" />
            ) : t.id === "code" ? (
              <CodeIcon size={14} aria-hidden="true" />
            ) : t.id === "database" ? (
              <DatabaseIcon size={14} aria-hidden="true" />
            ) : (
              <TerminalIcon size={14} aria-hidden="true" />
            )}
            {t.label}
            {t.badge && (
              <span className={`artifact-count-badge artifact-count-${t.id}`} data-state={phase.name}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${projectId}-artifact-panel`}
        aria-labelledby={`${projectId}-artifact-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-text-3)]">
          <span>
            {state.buildId
              ? `Revision ${state.buildId.slice(0, 8)}`
              : "No selected revision"}
          </span>
          <SourceDownload
            buildId={state.buildId}
            available={Boolean(
              state.buildId &&
              files?.length &&
              ["success", "failed"].includes(phase.name) &&
              !(phase.name === "failed" && phase.outcomeUnknown),
            )}
          />
        </div>
        {/* Preview */}
        {tab === "preview" && (
          <div className="workspace-preview-surface">
            <div className="workspace-preview-bar workspace-preview-toolbar">
              <div
                className="workspace-preview-devices"
                role="group"
                aria-label="Preview viewport"
              >
                {(
                  [
                    { id: "desktop", label: "Desktop", icon: MonitorIcon },
                    { id: "tablet", label: "Tablet", icon: TabletIcon },
                    { id: "mobile", label: "Mobile", icon: SmartphoneIcon },
                  ] as const
                ).map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    title={`${label} preview`}
                    aria-label={`${label} preview`}
                    aria-pressed={viewport === id}
                    onClick={() => setViewport(id)}
                  >
                    <Icon size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
              <span role="status">
                Local preview{" "}
                {local.state.loading
                  ? "· checking"
                  : local.state.error
                    ? "· status unavailable"
                    : local.state.preview
                      ? `· ${local.state.preview.status}${local.state.preview.cleanupPending ? " · cleanup pending" : ""}`
                      : ""}
              </span>
              <Popover.Root>
                <Popover.Trigger
                  className="preview-details-trigger"
                  aria-label="Preview details"
                >
                  <InfoIcon size={15} aria-hidden="true" />
                  {(publishing.state.error ||
                    local.state.error ||
                    ["failed", "interrupted"].includes(
                      publishing.state.deployment?.status ?? "",
                    )) && <span className="sr-only">Needs attention</span>}
                </Popover.Trigger>
                <Popover.Portal keepMounted>
                  <Popover.Positioner
                    side="bottom"
                    align="start"
                    sideOffset={10}
                    className="preview-details-positioner"
                  >
                    <Popover.Popup className="preview-details-popup">
                      <Popover.Title>Preview details</Popover.Title>
                      <details className="workspace-preview-attention" open>
                        <summary>
                          {publishing.state.error ||
                          ["failed", "interrupted"].includes(
                            publishing.state.deployment?.status ?? "",
                          )
                            ? "Publishing needs attention"
                            : "Preview & publishing details"}
                        </summary>
                        {phase.name === "success" && (
                          <div className="workspace-preview-publishing">
                            <span>
                              {publishing.state.deployment
                                ? `Publishing · ${publishing.state.deployment.status}`
                                : publishing.state.enabled
                                  ? "Publishing is separate from local preview."
                                  : "Publishing is not enabled for this instance."}
                            </span>
                            {publishing.state.deployment?.status === "verifying" && <span role="status">Coolify finished. Checking the application URL and this published revision.</span>}
                            {canPublish &&
                              publishing.state.deployment?.status ===
                                "queued" && (
                                <button
                                  type="button"
                                  onClick={() => void publishing.cancelQueued()}
                                  className="underline"
                                >
                                  Cancel queued publish
                                </button>
                              )}
                            {publishing.state.deployment?.status ===
                              "interrupted" && (
                              <span role="alert">
                                {PUBLISHING_ERRORS[
                                  publishing.state.deployment.errorCode ?? ""
                                ] ??
                                  "Publishing was interrupted. The application may still be running. The instance administrator must reconcile it before another attempt."}
                              </span>
                            )}
                            {publishing.state.deployment?.status ===
                              "failed" && (
                              <span role="alert">
                                {PUBLISHING_ERRORS[
                                  publishing.state.deployment.errorCode ?? ""
                                ] ?? "Publishing failed."}{" "}
                                Your build and local preview are preserved.
                              </span>
                            )}
                            {publishing.state.error && (
                              <span role="alert">{publishing.state.error}</span>
                            )}
                          </div>
                        )}
                        <p className="workspace-preview-help">
                          Media follows this project’s preview permissions. If
                          embedded access fails, use Open in new tab.
                        </p>
                        <div className="workspace-preview-guide-links">
                          <DocumentationLink guide="guides/local-previews">
                            Preview guide →
                          </DocumentationLink>
                          <DocumentationLink guide="guides/private-publishing">
                            Publishing guide →
                          </DocumentationLink>
                        </div>
                      </details>
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
              <div className="workspace-preview-actions">
                <button type="button" aria-label="Refresh preview" title="Refresh preview access" disabled={local.state.loading || !state.buildId || phase.name !== "success"}
                  onClick={local.reload}><RefreshCwIcon size={14} aria-hidden="true" /></button>
                {local.state.preview?.status === "ready" && (
                  <>
                    <button
                      type="button"
                      onClick={() => void local.open()}
                      className="underline"
                    >
                      Open in new tab ↗
                    </button>
                  </>
                )}
                {canContribute &&
                  local.state.preview &&
                  ["queued", "preparing", "starting", "ready"].includes(
                    local.state.preview.status,
                  ) && (
                    <button
                      type="button"
                      onClick={() => void local.stop()}
                      className="underline"
                    >
                      Stop preview
                    </button>
                  )}
                {liveUrl && (
                  <a
                    href={liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Published app ↗
                  </a>
                )}
                {phase.name === "success" &&
                  publishing.state.deployment?.status !== "success" && (
                    <button
                      type="button"
                      onClick={() => void publishing.publish()}
                      disabled={
                        !canPublish ||
                        !publishing.state.enabled ||
                        publishing.state.loading ||
                        Boolean(
                          publishing.state.deployment &&
                          !["success", "failed", "cancelled"].includes(
                            publishing.state.deployment.status,
                          ),
                        )
                      }
                      className="workspace-publish-action disabled:opacity-50"
                    >
                      {canPublish
                        ? "Publish this revision"
                        : "Publishing is managed by the project owner"}
                    </button>
                  )}
              </div>
            </div>
            {local.state.url &&
            local.state.preview &&
            local.state.preview.buildId === state.buildId &&
            local.state.preview.status === "ready" ? (
              <>
                <iframe
                  key={local.state.preview.id}
                  src={local.state.url}
                  title="Local app preview"
                  sandbox="allow-scripts allow-forms allow-same-origin"
                  referrerPolicy="no-referrer"
                  className="workspace-preview-frame"
                  style={{
                    width:
                      viewport === "mobile"
                        ? 390
                        : viewport === "tablet"
                          ? 768
                          : "100%",
                    maxWidth: "100%",
                    alignSelf: "center",
                  }}
                />
              </>
            ) : (
              <div className="workspace-preview-empty">
                <h2>{previewTitle}</h2>
                <p className="max-w-md text-center text-sm text-[var(--color-text-2)]">
                  {!state.buildId
                    ? "Choose a build from the revision menu to inspect its preview."
                    : local.state.loading
                      ? "Reading the current preview state. Your build and source remain available."
                      : local.state.error
                        ? local.state.error
                      : !local.state.enabled
                        ? "Local previews are turned off for this instance. Ask the instance administrator to enable them. Building your app does not require publishing."
                        : !local.state.supported
                          ? "Local preview supports Next.js and Laravel 13. Your build and code are preserved."
                          : local.state.activePreview && local.state.activePreview.buildId !== state.buildId
                            ? "A preview of another revision is still reserved. Prepare this revision to replace it."
                            : local.state.preview
                              ? local.state.preview.error || PREVIEW_HELP[local.state.preview.status]
                              : phase.name === "success"
                                ? "Prepare a local preview of this build. Deployment is separate."
                                : "A successful build is needed for local preview."}
                </p>
                {state.buildId &&
                  phase.name === "success" &&
                  canContribute &&
                  local.state.enabled &&
                  local.state.supported &&
                  !local.state.loading &&
                  !["queued", "preparing", "starting"].includes(
                    local.state.preview?.status ?? "",
                  ) && (
                    <button
                      type="button"
                      onClick={() => void local.start()}
                      className="rounded bg-[var(--color-primary)] px-4 py-2 text-sm text-[var(--color-on-primary)]"
                    >
                      {local.state.preview || local.state.activePreview
                        ? "Prepare this revision again"
                        : "Prepare local preview"}
                    </button>
                  )}
              </div>
            )}
            {local.state.preview?.log && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs">
                  Preview preparation and runtime logs
                </summary>
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-xs">
                  {local.state.preview.log}
                </pre>
              </details>
            )}
            {local.state.error && (
              <p
                role="alert"
                className="mt-3 text-sm text-[var(--color-danger)]"
              >
                {local.state.error}
              </p>
            )}
          </div>
        )}

        {/* Code */}
        {tab === "code" && (
          <div className="flex min-h-0 flex-1">
            <CodeEditor
              files={files ?? []}
              selectedFile={selected}
              onSelectFile={(index) =>
                setSelectedPath(files?.[index]?.path ?? null)
              }
            />
          </div>
        )}

        {/* Logs */}
        {tab === "database" && <div className="database-artifact-pane">{databasePane}</div>}
        {tab === "logs" && (
          <WorkspaceLogs
            key={state.buildId ?? "no-revision"}
            revisionId={state.buildId}
            sources={collectWorkspaceDiagnostics(
              state,
              local.state,
              publishing.state,
            )}
          />
        )}
      </div>
    </div>
  );
}
