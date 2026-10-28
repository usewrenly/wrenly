"use client";
import Link from "next/link";
import { authClient } from "@/lib/auth/auth-client";
// COMPONENT: Conversation, selected revision and live build composition
// Coordinates conversation, selected source revision and build observation without owning server execution.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useBuildStream } from "@/hooks/use-build-stream";
import { useConversation } from "@/hooks/use-conversation";
import {
  ACTIVE_TURN_STATUSES,
  parseConversationRequest,
  type ConversationMode,
} from "@/lib/conversations/contracts";
import { hydrateBuildState, INITIAL_BUILD_STATE } from "@/lib/builds/build-state";
import { relativeTime } from "@/lib/format";
import type { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { DatabaseWorkspace } from "./databases/database-workspace";
import { DatabaseBuildSelector } from "./databases/database-build-selector";
import "./databases/database-overview.css";
import { Composer } from "./composer";
import { ProjectSkills } from "./settings/project-skills";
import { PreviewMediaSettings } from "./artifacts/preview-media-settings";
import { ArtifactPane } from "./artifacts/artifact-pane";
import {
  ConversationTimeline,
  type WorkspaceBuild,
} from "./conversation/conversation-timeline";
import { StackBadge } from "@/components/shell/stack-badge";
import { StatusPill } from "@/components/shell/status-pill";
import {
  SettingsIcon,
  ArrowLeftRightIcon,
  ChevronDownIcon,
  MessageSquareIcon,
  PanelsTopLeftIcon,
  CodeIcon,
  TerminalIcon,
  DatabaseIcon,
  BookOpenIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const MIN_PANE_WIDTH = 320;
const MAX_CONVERSATION_WIDTH = 720;
const DEFAULT_CONVERSATION_WIDTH = 440;
const RESIZE_STEP = 24;
const DIVIDER_WIDTH = 7;
const SPLIT_KEY = "wrenly:split";
const SCROLL_BOTTOM_THRESHOLD = 80;
const TERMINAL_BUILD = new Set(["success", "failed"]);

export function Workspace({
  projectId,
  databaseEnabled: databaseEnabledOverride = false,
}: {
  projectId: string;
  databaseEnabled?: boolean;
}): React.JSX.Element {
  const { data: viewerSession } = authClient.useSession();
  const [mediaRevision, setMediaRevision] = useState<string | null>(null);
  const [skillsPending, setSkillsPending] = useState(false);
  const [databaseChoice, setDatabaseChoice] = useState<{ projectId: string; actorId: string; value: BuildDatabaseSelection } | null>(null);

  const execution = useBuildStream(projectId);
  const conversation = useConversation(projectId);
  const [mode, setMode] = useState<ConversationMode>("auto");
  const [side, setSide] = useState<"conversation-left" | "conversation-right">(
    "conversation-left",
  );
  const [width, setWidth] = useState(DEFAULT_CONVERSATION_WIDTH);
  const [availableWidth, setAvailableWidth] = useState(1040);
  const [mobileView, setMobileView] = useState<
    "conversation" | "preview" | "code" | "logs" | "database"
  >("conversation");
  const [artifactTab, setArtifactTab] = useState<"preview" | "code" | "logs" | "database">(
    "preview",
  );
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const [selectedBuildId, setSelectedBuildId] = useState<
    string | null | undefined
  >(undefined);
  const [legacyDraft, setLegacyDraft] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [publishedUrls, setPublishedUrls] = useState<Record<string, string>>(
    {},
  );
  const selectedRef = useRef(selectedBuildId);
  selectedRef.current = selectedBuildId;
  const observedActions = useRef(new Set<string>());
  const handoff = useRef<string | null>(null);
  const dragging = useRef(false);
  const [revisionRequest, setRevisionRequest] = useState<{id: string; text: string} | null>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const retryBase = useRef<string | null>(null);
  const {
    data,
    refetch,
    error: projectError,
  } = useQuery({
    queryKey: ["project", projectId],
    refetchInterval: 3000,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await apiFetch(`/api/projects/${projectId}`, { signal });
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "Project not found"
            : "The project could not be loaded. Check the API and reconnect.",
        );
      return response.json() as Promise<{
        features?: { developmentDatabases?: boolean };
        project: {
          id: string;
          name: string;
          stack: string;
          archivedAt?: string | null;
          accessMode?: string;
        };
        capabilities?: {
          role: string;
          contribute: boolean;
          manage: boolean;
          publish: boolean;
        };
        projectModel?: {
          connectionId: string;
          modelId: string;
          version: string;
          enabled: boolean;
        } | null;
        builds: WorkspaceBuild[];
      }>;
    },
  });
  const databaseEnabled = databaseEnabledOverride || data?.features?.developmentDatabases === true;
  const selectedDatabase = databaseEnabled && databaseChoice?.projectId === projectId && databaseChoice.actorId === viewerSession?.user.id ? databaseChoice.value : undefined;
  const project = data?.project;
  const permissions = data?.capabilities;
  const canContribute = permissions?.contribute ?? Boolean(project);
  const shared = Boolean(
    project?.accessMode && project.accessMode !== "private",
  );
  const fixedModel =
    shared && data?.projectModel
      ? {
          provider: `saved:${data.projectModel.connectionId}:${data.projectModel.version}`,
          model: data.projectModel.modelId,
        }
      : undefined;
  const builds = useMemo(() => data?.builds ?? [], [data]);
  const revisionNumbers = new Map(
    [...builds]
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      )
      .map((build, index) => [build.id, String(index + 1).padStart(2, "0")]),
  );
  const chooseBuild = useCallback((id: string): void => {
    selectedRef.current = id;
    setSelectedBuildId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("build", id);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  useEffect(() => {
    observedActions.current.clear();
    handoff.current = null;
    const restore = (): void =>
      setSelectedBuildId(
        new URL(window.location.href).searchParams
          .get("build")
          ?.toLowerCase() ?? null,
      );
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [projectId]);
  useEffect(() => {
    if (selectedBuildId === null && builds[0]) chooseBuild(builds[0].id);
  }, [builds, selectedBuildId, chooseBuild]);

  // Observation is independent of revision browsing. Only new action admission can auto-select a build.
  useEffect(() => {
    const latest = conversation.latest;
    if (
      latest?.buildId &&
      ACTIVE_TURN_STATUSES.has(latest.status) &&
      !observedActions.current.has(latest.buildId)
    ) {
      observedActions.current.add(latest.buildId);
      if (selectedRef.current === latest.baseBuildId)
        chooseBuild(latest.buildId);
      void refetch();
    }
    const active =
      latest?.buildId && latest.status === "waiting_build"
        ? latest.buildId
        : builds.find((build) => !TERMINAL_BUILD.has(build.status))?.id;
    if (active && execution.state.buildId !== active) {
      execution.hydrate(
        builds.find((build) => build.id === active) ?? {
          id: active,
          status: "pending",
          files: null,
          buildLog: null,
          deployedUrl: null,
          attemptCount: 0,
        },
      );
    }
  }, [
    conversation.latest,
    builds,
    execution.state.buildId,
    execution.hydrate,
    chooseBuild,
    refetch,
  ]);
  useEffect(() => {
    if (
      conversation.latest &&
      !ACTIVE_TURN_STATUSES.has(conversation.latest.status)
    )
      void refetch();
  }, [conversation.latest?.id, conversation.latest?.status, refetch]);
  useEffect(() => {
    if (
      execution.state.streamed &&
      ["success", "failed"].includes(execution.state.phase.name)
    )
      void refetch();
  }, [
    execution.state.phase.name,
    execution.state.buildId,
    execution.state.streamed,
    refetch,
  ]);

  // New handoffs have one stable conversation key. Old request-owned build handoffs are not replayed silently.
  useEffect(() => {
    if (
      !project ||
      conversation.loading ||
      conversation.error ||
      conversation.submitting
    )
      return;
    const key = `wrenly:pending:${projectId}`;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw || handoff.current === raw) return;
      handoff.current = raw;
      const saved = JSON.parse(raw) as Record<string, unknown>;
      if (
        saved.kind !== "conversation" ||
        typeof saved.idempotencyKey !== "string"
      ) {
        if (typeof saved.prompt === "string")
          setLegacyDraft({ id: key, text: saved.prompt });
        setWorkspaceError(
          "An older pending build draft was found. Review build history before sending it again.",
        );
        return;
      }
      const request = parseConversationRequest(saved);
      setMode(request.mode);
      const acknowledged = conversation.resume(request, saved.idempotencyKey);
      const recovery = sessionStorage.getItem(
        `wrenly:conversation-pending:${projectId}`,
      );
      if (
        recovery &&
        (JSON.parse(recovery) as { key?: string }).key === saved.idempotencyKey
      )
        sessionStorage.removeItem(key);
      void acknowledged.then((accepted) => {
        if (accepted && sessionStorage.getItem(key) === raw)
          sessionStorage.removeItem(key);
      });
    } catch {
      setWorkspaceError(
        "The pending dashboard message could not be restored. Review the draft before submitting again.",
      );
    }
  }, [
    project,
    projectId,
    conversation.loading,
    conversation.error,
    conversation.submitting,
    conversation.resume,
  ]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SPLIT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { side?: string; width?: number };
      if (
        saved.side === "conversation-left" ||
        saved.side === "conversation-right"
      )
        setSide(saved.side);
      if (typeof saved.width === "number")
        setWidth(
          Math.min(
            MAX_CONVERSATION_WIDTH,
            Math.max(MIN_PANE_WIDTH, saved.width),
          ),
        );
    } catch {
      /* Invalid local layout preferences must not block the conversation. */
    }
  }, []);
  const persistSplit = (nextSide: typeof side, nextWidth: number): void => {
    try {
      localStorage.setItem(
        SPLIT_KEY,
        JSON.stringify({ side: nextSide, width: nextWidth }),
      );
    } catch {
      /* Layout remains usable without storage. */
    }
  };
  const maximumWidth = Math.max(
    MIN_PANE_WIDTH,
    Math.min(
      MAX_CONVERSATION_WIDTH,
      availableWidth - MIN_PANE_WIDTH - DIVIDER_WIDTH,
    ),
  );
  const effectiveWidth = Math.min(width, maximumWidth);
  const changeWidth = (next: number): void => {
    const clamped = Math.max(MIN_PANE_WIDTH, Math.min(maximumWidth, next));
    setWidth(clamped);
    persistSplit(side, clamped);
  };
  useEffect(() => {
    const element = splitRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      dragging.current = false;
      setAvailableWidth(element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const swapSides = (): void => {
    const next =
      side === "conversation-left" ? "conversation-right" : "conversation-left";
    setSide(next);
    persistSplit(next, width);
  };

  const selected = builds.find((build) => build.id === selectedBuildId);
  const artifactState =
    selectedBuildId && execution.state.buildId === selectedBuildId
      ? execution.state
      : selected
        ? hydrateBuildState(selected)
        : INITIAL_BUILD_STATE;
  const liveUrl = selectedBuildId
    ? (publishedUrls[selectedBuildId] ?? selected?.deployedUrl ?? null)
    : null;
  const revisionUnavailable =
    selectedBuildId !== undefined &&
    selectedBuildId !== null &&
    !selected &&
    execution.state.buildId !== selectedBuildId;
  const selectionRunning = Boolean(
    selected && !TERMINAL_BUILD.has(selected.status),
  );
  const disabled =
    !canContribute ||
    (shared && !data?.projectModel?.enabled) ||
    !project ||
    Boolean(projectError) ||
    conversation.loading ||
    Boolean(conversation.error) ||
    conversation.busy ||
    execution.busy ||
    revisionUnavailable ||
    selectionRunning;
  const retryBuild = (build: WorkspaceBuild): void => {
    if (disabled) return;
    setWorkspaceError(null);
    retryBase.current = build.id;
    void execution.start({ retryBuildId: build.id }).finally(() => {
      retryBase.current = null;
    });
  };
  useEffect(() => {
    if (
      retryBase.current &&
      execution.state.buildId &&
      execution.state.buildId !== retryBase.current
    ) {
      if (selectedRef.current === retryBase.current)
        chooseBuild(execution.state.buildId);
      retryBase.current = null;
    }
  }, [execution.state.buildId, chooseBuild]);
  const viewBuild = (id: string): void => {
    chooseBuild(id);
    setMobileView(artifactTab);
    if (
      execution.state.buildId === id &&
      execution.state.phase.name === "failed" &&
      execution.state.phase.outcomeUnknown
    ) {
      const saved = builds.find((build) => build.id === id);
      if (saved) execution.hydrate(saved);
    }
  };
  const cancelUnlinkedBuild = async (): Promise<void> => {
    if (!execution.state.buildId) return;
    try {
      const response = await apiFetch(
        `/api/builds/${execution.state.buildId}/cancel`,
        { method: "POST" },
      );
      if (!response.ok)
        throw new Error(
          "Build cancellation could not be confirmed. Reconnect to check saved progress.",
        );
    } catch (error) {
      setWorkspaceError(
        error instanceof Error
          ? error.message
          : "Build cancellation is unavailable.",
      );
    }
  };
  const draft = useMemo(
    () =>
      conversation.draft
        ? {
            id: conversation.draft.id,
            text: conversation.draft.request.message,
          }
        : null,
    [conversation.draft],
  );
  useEffect(() => {
    if (conversation.draft) setMode(conversation.draft.request.mode);
  }, [conversation.draft]);

  useEffect(() => {
    const element = chatScroll.current;
    if (element && followBottom.current)
      element.scrollTop = element.scrollHeight;
  }, [
    conversation.messages.length,
    conversation.latest?.status,
    execution.state.logs.length,
  ]);

  const chat = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={chatScroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          followBottom.current =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            SCROLL_BOTTOM_THRESHOLD;
          setAwayFromBottom(!followBottom.current);
        }}
        className="workspace-conversation-scroll min-h-0 flex-1 overflow-y-auto"
      >
        <ConversationTimeline
          viewerName={viewerSession?.user?.name}
          viewerId={viewerSession?.user?.id}
          messages={conversation.messages}
          turns={conversation.turns}
          builds={builds}
          execution={execution.state}
          disabled={disabled || skillsPending}
          onView={viewBuild}
          onRetryBuild={retryBuild}
          onRevise={(message) => {
            if (disabled || conversation.draft || !viewerSession?.user?.id || message.author?.id !== viewerSession.user.id) return;
            setRevisionRequest({id: crypto.randomUUID(), text: message.content});
          }}
          onRetryResponse={(turn) => {
            void conversation.retry(turn);
          }}
        />
        {conversation.loading && (
          <p role="status" className="mt-3 text-xs text-[var(--color-text-3)]">
            Loading saved conversation…
          </p>
        )}
        {execution.state.phase.name === "failed" &&
          !execution.state.buildId && (
            <p role="alert" className="mt-3 text-sm">
              {execution.state.phase.error}
            </p>
          )}
        {(conversation.error || workspaceError) && (
          <div
            role="alert"
            className="mt-4 space-y-2 rounded-md border border-[var(--color-border)] p-3 text-sm"
          >
            <p>{conversation.error ?? workspaceError}</p>
            <button
              type="button"
              onClick={() => {
                if (conversation.unknown) void conversation.checkPending();
                else {
                  setWorkspaceError(null);
                  conversation.reconnect();
                  void refetch();
                }
              }}
              className="text-xs underline"
            >
              {conversation.unknown
                ? "Check saved request"
                : "Reconnect history"}
            </button>
            {conversation.invalidPending && (
              <button
                type="button"
                className="ml-3 text-xs underline"
                onClick={conversation.dismissInvalidPending}
              >
                Dismiss invalid draft
              </button>
            )}
          </div>
        )}
      </div>
      {awayFromBottom && (
        <button
          type="button"
          className="workspace-jump"
          onClick={() => {
            followBottom.current = true;
            setAwayFromBottom(false);
            chatScroll.current?.scrollTo({
              top: chatScroll.current.scrollHeight,
              behavior: "instant",
            });
          }}
        >
          Jump to latest ↓
        </button>
      )}
      <div className="workspace-composer-area space-y-2 border-t border-[var(--color-border)] p-3">
        <div className="flex items-center justify-between gap-2 text-xs text-[var(--color-text-2)]">
          <span>
            {selectedBuildId
              ? `Selected revision ${selectedBuildId.slice(0, 8)}`
              : "No revision yet"}
          </span>
          {canContribute &&
            (permissions?.manage ||
              selected?.author?.id === viewerSession?.user?.id ||
              !permissions) &&
            execution.busy &&
            execution.state.buildId &&
            conversation.latest?.buildId !== execution.state.buildId && (
              <button
                type="button"
                className="underline"
                onClick={() => void cancelUnlinkedBuild()}
              >
                Cancel build
              </button>
            )}
          {canContribute &&
            (permissions?.manage ||
              conversation.latest?.actorId === viewerSession?.user?.id ||
              !permissions) &&
            conversation.latest &&
            ACTIVE_TURN_STATUSES.has(conversation.latest.status) && (
              <button
                type="button"
                onClick={() => void conversation.cancel()}
                className="underline"
              >
                Cancel {conversation.latest.buildId ? "build" : "response"}
              </button>
            )}
        </div>
        {revisionUnavailable && (
          <p role="alert" className="text-xs">
            Selected revision is unavailable. Choose a revision from History.
          </p>
        )}
        {!canContribute && (
          <p role="status">
            {project?.archivedAt
              ? "This project is archived. Its history is available; restore it in project settings to make changes."
              : "You have Viewer access. Ask the project owner for Editor access to send prompts."}
          </p>
        )}
        {shared && (
          <p className="workspace-project-model">
            Project model:{" "}
            {data?.projectModel?.modelId ??
              "Not configured — ask the project owner"}
          </p>
        )}
        {databaseEnabled && viewerSession?.user.id && canContribute ? <DatabaseBuildSelector
          key={`${projectId}:${viewerSession.user.id}`} projectId={projectId} actorId={viewerSession.user.id}
          value={selectedDatabase} disabled={disabled} onChange={value => setDatabaseChoice(value ? { projectId, actorId: viewerSession.user.id, value } : null)} /> : null}
        <Composer
          key={projectId}
          projectTools={<><details><summary><BookOpenIcon size={16} aria-hidden="true" />Project Skills</summary><ProjectSkills projectId={projectId} onPendingChange={setSkillsPending} /></details><PreviewMediaSettings projectId={projectId} onRevision={setMediaRevision} /></>}
          readOnly={!canContribute}
          fixedModel={fixedModel}
          framework={project?.stack}
          mode={mode}
          onModeChange={setMode}
          draft={draft ?? legacyDraft}
          revisionRequest={revisionRequest}
          revisionBaseLabel={selectedBuildId ? `Revision ${selectedBuildId.slice(0, 8)}` : "No base revision"}
          disabled={disabled}
          placeholder={
            conversation.busy
              ? "Working on your message…"
              : mode === "plan"
                ? "Plan your app or discuss the next change…"
                : "Ask Wrenly a question or describe a change…"
          }
          onSubmit={async (message, _stack, model, provider, chosenMode) => {
            if (disabled) return false;
            setWorkspaceError(null);
            const accepted = await conversation.submit({
              message,
              mode: chosenMode ?? "auto",
              baseBuildId: selectedBuildId ?? null,
              ...(selectedDatabase ? { database: selectedDatabase } : {}),
              model,
              provider,
            });
            if (accepted && legacyDraft) {
              sessionStorage.removeItem(`wrenly:pending:${projectId}`);
              setLegacyDraft(null);
            }
            return accepted;
          }}
        />

      </div>
    </div>
  );
  const artifacts = (
    <ArtifactPane
      mediaRevision={mediaRevision}
      databasePane={databaseEnabled && viewerSession?.user.id ? <DatabaseWorkspace projectId={projectId} actorId={viewerSession.user.id} selectedBuildId={selectedBuildId ?? undefined} selectedBuildSuccessful={artifactState.phase.name === "success"} /> : undefined}
      canContribute={canContribute}
      canPublish={permissions?.publish ?? Boolean(project)}
      tab={artifactTab}
      onTabChange={setArtifactTab}
      state={artifactState}
      projectId={projectId}
      liveUrl={liveUrl}
      onDeployed={(url) => {
        if (selectedBuildId)
          setPublishedUrls((previous) => ({
            ...previous,
            [selectedBuildId]: url,
          }));
      }}
    />
  );
  if (projectError)
    return (
      <div role="alert" className="p-8">
        <p>{projectError.message}</p>
        <p>Your workspace data is hidden until access can be checked again.</p>
        <button onClick={() => void refetch()}>Check project access</button>
        <Link href="/projects">All projects →</Link>
      </div>
    );
  return (
    <div className="workspace-frame flex h-full min-h-0 flex-col">
      {revisionUnavailable && (
        <p role="alert" className="p-3 text-sm">
          Selected revision is unavailable. Choose a revision from History.
        </p>
      )}
      <div className="workspace-toolbar">
        <span className="truncate text-sm font-semibold">
          {project?.name ?? "…"}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Revision history"
            className="workspace-revision-trigger"
          >
            {selectedBuildId
              ? `Revision ${revisionNumbers.get(selectedBuildId) ?? selectedBuildId.slice(0, 8)}`
              : "Revision history"}{" "}
            <ChevronDownIcon className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {builds.length === 0 && (
              <p className="p-3 text-xs">No builds yet.</p>
            )}
            {(["success", "failed", "active"] as const).map((group) => {
              const rows = builds.filter((build) =>
                group === "active"
                  ? !TERMINAL_BUILD.has(build.status)
                  : build.status === group,
              );
              return (
                rows.length > 0 && (
                  <div key={group}>
                    <div className="px-2 py-1 text-[10px] uppercase text-[var(--color-text-2)]">
                      {group === "success"
                        ? "Validated builds"
                        : group === "failed"
                          ? "Failed builds"
                          : "In progress"}
                    </div>
                    {rows.map((build) => (
                      <DropdownMenuItem
                        key={build.id}
                        onClick={() => chooseBuild(build.id)}
                        className={
                          selectedBuildId === build.id
                            ? "bg-[var(--color-surface-2)]"
                            : ""
                        }
                      >
                        <div className="min-w-0">
                          <div className="truncate text-xs">
                            <span className="workspace-revision-number">
                              {revisionNumbers.get(build.id)}
                            </span>{" "}
                            {build.prompt.slice(0, 45)}
                          </div>
                          <div className="text-[10px] text-[var(--color-text-2)]">
                            {selectedBuildId === build.id ? "Selected · " : ""}
                            {build.id.slice(0, 8)} ·{" "}
                            {relativeTime(build.createdAt)} · {build.status}
                          </div>
                        </div>
                      </DropdownMenuItem>
                    ))}
                  </div>
                )
              );
            })}
            {!builds.length && <p className="p-2 text-xs">No builds yet</p>}
          </DropdownMenuContent>
        </DropdownMenu>
        {project && <StackBadge stack={project.stack} />}
        <StatusPill status={artifactState.phase.name} />
        <button
          type="button"
          aria-label="Swap conversation and artifact sides"
          disabled={skillsPending}
          className="workspace-swap"
          onClick={swapSides}
        >
          <ArrowLeftRightIcon size={15} />
        </button>
        <Link
          className="workspace-share-link"
          href={`/p/${projectId}/settings`}
        >
          {permissions?.manage
            ? "Share"
            : permissions?.role
              ? `${permissions.role} · Access`
              : "Project access"}
        </Link>
        {project && (
          <Link
            href={`/p/${projectId}/settings`}
            aria-label="Project settings"
            className="workspace-settings-link"
          >
            <SettingsIcon size={15} />
          </Link>
        )}
      </div>
      <div className="workspace-mobile-views" aria-label="Workspace views">
        {(["conversation", "preview", "code", "logs", ...(databaseEnabled ? ["database" as const] : [])] as const).map((view) => (
          <button
            key={view}
            type="button"
            aria-pressed={mobileView === view}
            onClick={() => {
              setMobileView(view);
              if (view !== "conversation") setArtifactTab(view);
            }}
          >
            {view === "conversation" ? (
              <MessageSquareIcon size={14} aria-hidden="true" />
            ) : view === "preview" ? (
              <PanelsTopLeftIcon size={14} aria-hidden="true" />
            ) : view === "code" ? (
              <CodeIcon size={14} aria-hidden="true" />
            ) : view === "database" ? (
              <DatabaseIcon size={14} aria-hidden="true" />
            ) : (
              <TerminalIcon size={14} aria-hidden="true" />
            )}
            {view === "conversation"
              ? "Conversation"
              : view === "preview"
                ? "Preview"
                : view === "code"
                  ? "Code"
                  : view === "database" ? "Database" : "Logs"}
            {view === "database" && <span className="database-experimental-badge">Experimental</span>}
          </button>
        ))}
      </div>
      <div
        ref={splitRef}
        className="workspace-split"
        data-side={side}
        data-mobile-view={mobileView}
      >
        <section
          aria-label="Conversation pane"
          className="workspace-chat"
          style={{ width: effectiveWidth }}
        >
          {chat}
        </section>
        <div
          ref={dividerRef}
          role="separator"
          tabIndex={0}
          aria-label="Resize conversation pane"
          aria-orientation="vertical"
          aria-valuemin={MIN_PANE_WIDTH}
          aria-valuemax={maximumWidth}
          aria-valuenow={effectiveWidth}
          className="workspace-divider"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!dragging.current) return;
            const rect = splitRef.current?.getBoundingClientRect();
            if (rect)
              changeWidth(
                side === "conversation-left"
                  ? event.clientX - rect.left
                  : rect.right - event.clientX,
              );
          }}
          onPointerUp={(event) => {
            dragging.current = false;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            changeWidth(
              event.key === "Home"
                ? MIN_PANE_WIDTH
                : event.key === "End"
                  ? maximumWidth
                  : effectiveWidth +
                    (event.key === "ArrowRight" ? 1 : -1) *
                      (side === "conversation-left" ? 1 : -1) *
                      RESIZE_STEP,
            );
          }}
        />
        <section aria-label="Artifact pane" className="workspace-artifacts">
          {artifacts}
        </section>
      </div>
    </div>
  );
}
export function WorkspaceWrapper({
  projectId,
}: {
  projectId: string;
}): React.JSX.Element {
  return <Workspace key={projectId} projectId={projectId} />;
}
