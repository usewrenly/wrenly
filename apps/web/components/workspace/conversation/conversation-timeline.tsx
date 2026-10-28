"use client";
// COMPONENT: Persisted messages and distinct execution activity
// Combines saved user/model messages with distinct build execution activity.
import {
  ACTIVE_TURN_STATUSES,
  type ConversationMessage,
  type ConversationTurn,
} from "@/lib/conversations/contracts";
import { SkillsUsed } from "./skills-used";
import { ExecutionActivity } from "./execution-activity";
import { AssistantMessage } from "./assistant-message";
import { PromptRow, ActivityRow } from "./timeline";
import type { BuildStreamState } from "@/lib/builds/build-state";

export interface WorkspaceBuild {
  author?: { id: string; name: string; pictureUrl: string | null } | null;
  id: string;
  prompt: string;
  model: string | null;
  provider: string | null;
  stack: string | null;
  parentBuildId: string | null;
  status: string;
  outcome?: string | null;
  attemptCount: number;
  buildLog: string | null;
  errorMessage: string | null;
  deployedUrl: string | null;
  files: Array<{ path: string; content: string }> | null;
  createdAt: string;
}
function BuildActivity({
  build,
  state,
  onView,
  onRetry,
  outcome,
}: {
  outcome?: string;
  build?: WorkspaceBuild;
  state?: BuildStreamState;
  onView: () => void;
  onRetry?: () => void;
}): React.JSX.Element {
  const phase = state?.phase;
  const status =
    phase?.name === "idle" || !phase
      ? (build?.status ?? "pending")
      : phase.name;
  const terminal = status === "success" || status === "failed";
  return (
    <div className="workspace-build-activity space-y-2" data-build-activity>
      <ActivityRow
        status={
          status === "success" ||
          status === "failed" ||
          status === "generating" ||
          status === "building" ||
          status === "retrying"
            ? status
            : "pending"
        }
        message={phase && "message" in phase ? phase.message : undefined}
        attempt={
          phase && "attempt" in phase ? phase.attempt : build?.attemptCount
        }
        fileCount={state?.files?.length ?? build?.files?.length}
        error={
          phase && "error" in phase
            ? phase.error
            : (build?.errorMessage ?? undefined)
        }
        errorTitle={
          phase?.name === "failed" && phase.outcomeUnknown
            ? "Build outcome unconfirmed"
            : (outcome ?? build?.outcome) === "cancelled"
              ? "Build cancelled"
              : (outcome ?? build?.outcome) === "interrupted"
                ? "Build interrupted"
                : undefined
        }
        onRetry={
          status === "failed" &&
          !(phase?.name === "failed" && phase.outcomeUnknown)
            ? onRetry
            : undefined
        }
      />
      <button type="button" onClick={onView} className="text-xs underline">
        {phase?.name === "failed" && phase.outcomeUnknown
          ? "Reconnect build progress"
          : terminal
            ? "View revision"
            : "View build progress"}
      </button>
      <SkillsUsed buildId={build?.id ?? state?.buildId ?? undefined} />
      {(build?.id || state?.buildId) && (
        <ExecutionActivity
          buildId={build?.id ?? state!.buildId!}
          active={Boolean(state) && !terminal}
        />
      )}
      {state?.logs.length || build?.buildLog ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--color-text-2)]">
            Build logs
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface-2)] p-3 font-mono">
            {state ? state.logs.join("\n") : build?.buildLog}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/** Keeps real messages, tool activity and legacy build history distinct without deduplicating user text. */
export function ConversationTimeline({
  viewerName,
  viewerId,
  messages,
  turns,
  builds,
  execution,
  disabled,
  onView,
  onRetryBuild,
  onRetryResponse,
  onRevise,
}: {
  viewerName?: string;
  viewerId?: string;
  messages: ConversationMessage[];
  turns: ConversationTurn[];
  builds: WorkspaceBuild[];
  execution: BuildStreamState;
  disabled: boolean;
  onView: (id: string) => void;
  onRetryBuild: (build: WorkspaceBuild) => void;
  onRetryResponse: (turn: ConversationTurn) => void;
  onRevise?: (message: ConversationMessage) => void;
}): React.JSX.Element {
  const linked = new Set(turns.map((turn) => turn.buildId).filter(Boolean));
  const unlinkedExecution =
    execution.streamed && execution.buildId && !linked.has(execution.buildId)
      ? execution.buildId
      : null;
  const legacy = builds.filter(
    (build) => !linked.has(build.id) && build.id !== unlinkedExecution,
  );
  const unlinkedBuild = builds.find((build) => build.id === unlinkedExecution);
  const grouped = new Map<string, ConversationMessage[]>();
  for (const message of messages)
    grouped.set(message.turnId, [
      ...(grouped.get(message.turnId) ?? []),
      message,
    ]);
  return (
    <div className="flex flex-col gap-6" aria-label="Project conversation">
      {legacy.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--color-text-2)]">
            Build history outside this conversation ({legacy.length})
          </summary>
          <div className="mt-3 space-y-4">
            {[...legacy].reverse().map((build) => (
              <div key={build.id} className="space-y-2">
                <p className="text-[var(--color-text-2)]">{build.prompt}</p>
                <BuildActivity
                  build={build}
                  state={execution.buildId === build.id ? execution : undefined}
                  onView={() => onView(build.id)}
                  onRetry={disabled ? undefined : () => onRetryBuild(build)}
                />
              </div>
            ))}
          </div>
        </details>
      )}
      {unlinkedExecution && (
        <section
          className="space-y-2"
          aria-label="Build activity outside conversation"
        >
          <p className="text-xs text-[var(--color-text-3)]">
            Build activity outside the conversation
          </p>
          <BuildActivity
            build={unlinkedBuild}
            state={execution}
            onView={() => onView(unlinkedExecution)}
            onRetry={
              disabled || !unlinkedBuild
                ? undefined
                : () => onRetryBuild(unlinkedBuild)
            }
          />
        </section>
      )}
      {[...grouped].map(([id, entries]) => {
        const turn = turns.find((value) => value.id === id);
        const build = builds.find((value) => value.id === turn?.buildId);
        return (
          <section key={id} className="space-y-3" data-turn-id={id}>
            <SkillsUsed items={turn?.skillsUsed ?? []} />
            {entries.map((message) =>
              message.role === "user" ? (
                <PromptRow
                  key={message.id}
                  author={message.author}
                  viewerName={viewerName}
                  viewerId={viewerId}
                  content={message.content}
                  timestamp={message.createdAt}
                  onRevise={
                    !disabled &&
                    viewerId &&
                    message.author?.id === viewerId &&
                    onRevise
                      ? () => onRevise(message)
                      : undefined
                  }
                />
              ) : (
                <AssistantMessage key={message.id} content={message.content} />
              ),
            )}
            {turn?.status === "completed" &&
              !turn.buildId &&
              entries.some(
                (message) =>
                  message.role === "assistant" && message.kind === "clarify",
              ) && (
                <p className="text-xs text-[var(--color-text-3)]">
                  Clarification requested. No build started for this message.
                </p>
              )}
            {turn && (
              <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-3)]">
                <span>
                  {turn.mode === "plan"
                    ? "Plan"
                    : turn.mode === "auto"
                      ? "Auto"
                      : turn.mode === "ask"
                        ? "Ask"
                        : "Build"}
                </span>
                {turn.baseBuildId && (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => onView(turn.baseBuildId!)}
                  >
                    Base revision {turn.baseBuildId.slice(0, 8)}
                  </button>
                )}
              </div>
            )}
            {turn?.buildId ? (
              <BuildActivity
                build={build}
                outcome={turn.status}
                state={
                  execution.buildId === turn.buildId ? execution : undefined
                }
                onView={() => onView(turn.buildId!)}
                onRetry={
                  disabled || !build ? undefined : () => onRetryBuild(build)
                }
              />
            ) : turn && ACTIVE_TURN_STATUSES.has(turn.status) ? (
              <p role="status" className="text-sm text-[var(--color-text-2)]">
                {turn.status === "queued"
                  ? "Message queued — waiting for the API worker."
                  : "Preparing a response…"}
              </p>
            ) : turn &&
              ["failed", "interrupted", "cancelled"].includes(turn.status) ? (
              <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3 text-sm">
                <p>
                  {turn.status === "interrupted"
                    ? "Response interrupted"
                    : turn.status === "cancelled"
                      ? "Response cancelled"
                      : "Response unavailable"}
                </p>
                {turn.errorMessage && (
                  <p className="text-[var(--color-text-2)]">
                    {turn.errorMessage}
                  </p>
                )}
                <button
                  type="button"
                  disabled={disabled}
                  className="text-xs underline disabled:opacity-50"
                  onClick={() => onRetryResponse(turn)}
                >
                  Retry response
                </button>
              </div>
            ) : null}
          </section>
        );
      })}
      {!messages.length && !legacy.length && !unlinkedExecution && (
        <p className="text-sm text-[var(--color-text-2)]">
          Discuss your app, ask a question, or describe what to build.
        </p>
      )}
    </div>
  );
}
