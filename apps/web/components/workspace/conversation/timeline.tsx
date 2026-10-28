"use client";
// User prompts, authors and build outcomes have distinct rows.
// Every operation state carries a text label so color is never its only signal.

import {
  ArrowUpRightIcon,
  CheckIcon,
  Loader2Icon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { CopyMessage } from "./copy-message";
import { ProfileAvatar } from "@/components/account/profile-avatar";
import { relativeTime } from "@/lib/format";

// ─── PromptRow ─────────────────────────────────────────────────────────────────

interface PromptRowProps {
  author?: { id: string; name: string; pictureUrl: string | null } | null;
  viewerName?: string;
  viewerId?: string;
  content: string;
  timestamp?: string;
  onRevise?: () => void;
}

/** The user's prompt — right-aligned, bordered, deliberately plain. */
export function PromptRow({
  content,
  timestamp,
  viewerName,
  viewerId,
  author,
  onRevise,
}: PromptRowProps): React.JSX.Element {
  return (
    <div className="workspace-user-message">
      <div className="workspace-user-brief">
        <div className="workspace-user-label">
          {author ? (author.id === viewerId ? "You" : author.name) : "You"}{" "}
          {timestamp && <span>· {relativeTime(timestamp)}</span>}
        </div>
        <p>{content}</p>
        <div className="workspace-prompt-actions">
          <CopyMessage content={content} />
          {onRevise && (
            <button type="button" onClick={onRevise}>
              Edit and resubmit
            </button>
          )}
        </div>
      </div>
      <ProfileAvatar
        name={author?.name ?? viewerName ?? "You"}
        userId={author?.id ?? viewerId}
        pictureUrl={author?.pictureUrl}
        own={!author || author.id === viewerId}
        className="workspace-user-avatar"
      />
    </div>
  );
}

// ─── ActivityRow ───────────────────────────────────────────────────────────────

export type ActivityStatus =
  | "pending"
  | "generating"
  | "building"
  | "retrying"
  | "deploying"
  | "success"
  | "failed";

/** Fallback copy per in-flight phase when the SSE message is absent. */
const LIVE_LABEL: Record<
  Exclude<ActivityStatus, "success" | "failed">,
  string
> = {
  pending: "Queued…",
  generating: "Generating files…",
  building: "Building in sandbox…",
  retrying: "Retrying with fixes…",
  deploying: "Deploying…",
};

interface ActivityRowProps {
  status: ActivityStatus;
  /** SSE phase message — overrides the default live label. */
  message?: string;
  attempt?: number;
  /** Success only: number of generated files. */
  fileCount?: number;
  /** Failure only: the sandbox/agent error tail. */
  error?: string;
  errorTitle?: string;
  /** Success only: the deployed URL, rendered as a chip. */
  deployedUrl?: string | null;
  timestamp?: string;
  onRetry?: () => void;
}

/**
 * One build outcome as a compact row:
 *   failed  → bordered card, red gutter, mono error tail, Retry action
 *   success → bordered row, green check, file count, live-URL chip
 *   pending/generating/building/retrying/deploying → borderless live row
 */
export function ActivityRow({
  status,
  message,
  attempt,
  fileCount,
  error,
  errorTitle,
  deployedUrl,
  timestamp,
  onRetry,
}: ActivityRowProps) {
  const meta = [
    attempt !== undefined ? `attempt ${attempt}` : null,
    status === "success" && fileCount !== undefined
      ? `${fileCount} files`
      : null,
    timestamp ? relativeTime(timestamp) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (status === "failed") {
    return (
      <div className="w-full overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-2 border-l-2 border-[var(--color-error)] px-3 py-2">
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-error-bg)]">
            <XIcon className="size-3 text-[var(--color-error)]" />
          </span>
          <span className="text-sm font-medium text-[var(--color-text-1)]">
            {errorTitle ?? "Build failed"}
          </span>
          {meta && (
            <span className="truncate font-mono text-[10px] text-[var(--color-text-3)]">
              {meta}
            </span>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-2)] transition-colors hover:text-[var(--color-text-1)]"
            >
              <RotateCcwIcon className="size-3" /> Retry
            </button>
          )}
        </div>
        {error && (
          <pre className="max-h-40 overflow-auto border-t border-[var(--color-border)] bg-[var(--color-error-bg)] px-3 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-[var(--color-error)]">
            {error}
          </pre>
        )}
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="flex w-full items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-success-bg)]">
          <CheckIcon className="size-3 text-[var(--color-success)]" />
        </span>
        <span className="text-sm font-medium text-[var(--color-text-1)]">
          Build succeeded
        </span>
        {meta && (
          <span className="truncate font-mono text-[10px] text-[var(--color-text-3)]">
            {meta}
          </span>
        )}
        {deployedUrl && (
          <a
            href={deployedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-dk)]"
          >
            live url <ArrowUpRightIcon className="size-3" />
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="flex w-full items-center gap-2 px-1 py-0.5">
      <Loader2Icon className="size-3.5 shrink-0 animate-spin text-[var(--color-text-2)]" />
      <span className="text-sm text-[var(--color-text-2)]">
        {message ?? LIVE_LABEL[status]}
      </span>
      {meta && (
        <span className="font-mono text-[10px] text-[var(--color-text-3)]">
          {meta}
        </span>
      )}
    </div>
  );
}
