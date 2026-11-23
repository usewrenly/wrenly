"use client";
/** Conversation cards observe saved actions; only an explicit owner click grants execution. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  DatabaseWorkflowCard as DatabaseWorkflowCardSchema,
  DatabaseWorkflowCards,
} from "@wrenly/db/conversation-workflow";
import {
  DatabaseIcon,
  CheckIcon,
  Loader2Icon,
  ArrowUpRightIcon,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const POLL_MS = 2000;
const Card = DatabaseWorkflowCardSchema;
const Cards = DatabaseWorkflowCards;
type WorkflowCard = z.infer<typeof Card>;
async function readResponse(
  response: Response,
): Promise<z.infer<typeof Cards>> {
  if (response.status === 404) return { canManage: false, workflows: [] };
  if (!response.ok || !response.body)
    throw new Error(
      "Database workflow status is unavailable. Reload before continuing.",
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new Error("Database review exceeds its display limit.");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return Cards.parse(JSON.parse(text));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** One status query is shared by the timeline; refreshing cannot authorize a database mutation. */
export function useDatabaseWorkflowCards(projectId: string): {
  data?: z.infer<typeof Cards>;
  error: Error | null;
} {
  return useQuery({
    queryKey: ["conversation-databases", projectId],
    queryFn: async ({ signal }) =>
      readResponse(
        await apiFetch(`/api/projects/${projectId}/database-workflows`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          cache: "no-store",
        }),
      ),
    refetchInterval: POLL_MS,
    retry: false,
  });
}
const LABELS: Record<WorkflowCard["state"], string> = {
  proposed: "Give this app persistent storage",
  setup: "Setting up your database",
  building: "Preparing the database-backed build",
  waiting_build: "Building your app",
  review: "Review the database changes",
  backup: "Creating and verifying a backup",
  migrating: "Rehearsing and applying approved changes",
  complete: "Database connected",
  blocked: "Database workflow needs attention",
  declined: "Database proposal declined",
  cancelled: "Future database steps stopped",
};
/** Changes to saved tables require a second, source-bound review rather than inferred chat consent. */
export function DatabaseWorkflowCard({
  card,
  projectId,
  canManage,
  onView,
}: {
  card: WorkflowCard;
  projectId: string;
  canManage: boolean;
  onView: (id: string) => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = [
    "setup",
    "building",
    "waiting_build",
    "backup",
    "migrating",
  ].includes(card.state);
  const approve = async (
    decision: "approve" | "decline" | "stop",
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/projects/${projectId}/database-workflows/${card.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: card.revision, decision }),
          signal: AbortSignal.timeout(15000),
        },
      );
      const data = await readResponse(response);
      client.setQueryData(["conversation-databases", projectId], data);
    } catch {
      setError(
        "Approval could not be confirmed. Reload the saved card before trying again.",
      );
    } finally {
      setBusy(false);
      await client.invalidateQueries({
        queryKey: ["conversation-databases", projectId],
      });
    }
  };
  return (
    <section
      className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
      aria-label="Database approval"
    >
      <div className="flex items-start gap-3 p-4">
        <div className="rounded-lg bg-[var(--color-surface-2)] p-2 text-[var(--color-text-2)]">
          <DatabaseIcon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{LABELS[card.state]}</h3>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-2)]">
            {card.state === "proposed"
              ? "Development keeps app records on this instance. Approving connects the database and continues this saved build request. Production stays separate."
              : card.state === "review"
                ? "Review these saved migration files. Approval creates a verified backup, rehearses the changes on disposable data, then applies this exact review."
                : card.state === "complete"
                  ? "The saved revision matches your Development database. Open the revision to prepare its preview."
                  : card.state === "blocked"
                    ? card.error
                    : "Progress is saved. You can leave this page and return."}
          </p>
        </div>
        {pending ? (
          <Loader2Icon size={16} className="animate-spin" />
        ) : card.state === "complete" ? (
          <CheckIcon size={16} className="text-green-600" />
        ) : null}
      </div>
      {card.state === "review" && (
        <div className="space-y-2 px-4 pb-4">
          {card.framework === "laravel" && (
            <p className="text-xs text-[var(--color-text-2)]">
              Laravel migrations run this revision’s application bootstrap.
              Review its Code as well as the migration files before approving.
            </p>
          )}
          {card.files.map((file) => (
            <details
              key={file.path}
              className="rounded-lg border border-[var(--color-border)] text-xs"
            >
              <summary className="cursor-pointer px-3 py-2 font-mono">
                {file.path}
              </summary>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap border-t border-[var(--color-border)] p-3">
                {file.content}
              </pre>
            </details>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
        {["proposed", "review"].includes(card.state) ? (
          canManage ? (
            <>
              <button
                type="button"
                disabled={busy || Boolean(error)}
                onClick={() => void approve("approve")}
                className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-medium text-[var(--color-on-primary)] disabled:opacity-50"
              >
                {busy
                  ? "Saving approval…"
                  : card.state === "review"
                    ? "Back up, rehearse & apply"
                    : card.resourceId
                      ? "Connect database & build"
                      : "Create database & build"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void approve("decline")}
                className="text-xs text-[var(--color-text-2)]"
              >
                Not now
              </button>
            </>
          ) : (
            <p className="text-xs text-[var(--color-text-2)]">
              The project owner needs to approve this step.
            </p>
          )
        ) : (
          <span role="status" className="text-xs text-[var(--color-text-2)]">
            {pending
              ? "Working on your instance"
              : card.state === "complete"
                ? "Ready for preview"
                : card.state === "declined"
                  ? "No work authorized"
                  : card.state === "cancelled"
                    ? "Already-started work may finish. Saved data is preserved."
                    : "Review saved database activity"}
          </span>
        )}
        {pending && canManage && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void approve("stop")}
            className="text-xs underline"
          >
            Stop after current step
          </button>
        )}
        {card.buildId && (
          <button
            type="button"
            className="ml-auto flex items-center gap-1 text-xs"
            onClick={() => onView(card.buildId!)}
          >
            Open revision <ArrowUpRightIcon size={13} />
          </button>
        )}
        {error && (
          <p role="alert" className="w-full text-xs">
            {error}{" "}
            <button
              type="button"
              className="underline"
              onClick={() => {
                void client
                  .invalidateQueries({
                    queryKey: ["conversation-databases", projectId],
                  }, { throwOnError: true })
                  .then(() => setError(null))
                  .catch(() => setError("Saved status is still unavailable. Reload again before approving."));
              }}
            >
              Reload card
            </button>
          </p>
        )}
      </div>
    </section>
  );
}
