"use client";
/** Reviews one owner request and follows its saved progress without creating work on mount. */
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  readProductionCreation,
  submitProductionCreation,
  readPendingProductionCreation,
  savePendingProductionCreation,
  clearPendingProductionCreation,
  ProductionCreationError,
  type PendingProductionCreation,
  type ProductionCreationState,
} from "@/lib/databases/production-creation";
const POLL_MS = 1500;
const PHASES = [
  "Create restricted roles",
  "Create the project database",
  "Grant private connections",
  "Prepare the application schema",
];
export function ProductionDatabaseCreation({
  actorId,
  projectId,
  onClose,
  onAccepted,
}: {
  actorId: string;
  projectId: string;
  onClose: () => void;
  onAccepted: () => void;
}): React.JSX.Element {
  const [state, setState] = useState<ProductionCreationState | null>(null);
  const [pending, setPending] = useState<PendingProductionCreation | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const accepted = useRef(onAccepted);
  accepted.current = onAccepted;
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh(): Promise<void> {
      try {
        const saved = readPendingProductionCreation(
          sessionStorage,
          actorId,
          projectId,
        );
        const current = await readProductionCreation(
          projectId,
          active.signal,
          saved?.input.requestId,
        );
        if (active.signal.aborted) return;
        setPending(saved);
        if (!current) {
          setError(
            "The saved request has not been confirmed yet. Check again or retry the same request.",
          );
          return;
        }
        setState(current);
        setError(null);
        if (saved && current.creation?.requestId === saved.input.requestId) {
          clearPendingProductionCreation(sessionStorage, saved);
          setPending(null);
        }
        if (current.creation?.status === "attached") {
          accepted.current();
          return;
        }
        if (
          current.creation &&
          ["queued", "creating", "created"].includes(current.creation.status)
        )
          timer = setTimeout(() => {
            void refresh();
          }, POLL_MS);
      } catch (cause) {
        if (!active.signal.aborted)
          setError(
            cause instanceof ProductionCreationError
              ? cause.message
              : "The saved request could not be read safely. Keep this browser open and check again.",
          );
      }
    }
    void refresh();
    return () => {
      active.abort();
      if (timer) clearTimeout(timer);
    };
  }, [actorId, projectId]);
  async function submit(): Promise<void> {
    const active = controller.current;
    if (!active || active.signal.aborted || busy) return;
    setBusy(true);
    try {
      const saved =
        pending ??
        readPendingProductionCreation(sessionStorage, actorId, projectId) ??
        (state?.connectionId
          ? {
              version: 1 as const,
              actorId,
              projectId,
              input: {
                requestId: crypto.randomUUID(),
                expectedRevision: state.projectRevision,
                connectionId: state.connectionId,
                confirmCreate: true as const,
              },
            }
          : null);
      if (!saved) throw new Error("Review instance setup first.");
      savePendingProductionCreation(sessionStorage, saved);
      setPending(saved);
      await submitProductionCreation(saved, active.signal);
      const current = await readProductionCreation(
        projectId,
        active.signal,
        saved.input.requestId,
      );
      if (active.signal.aborted) return;
      if (!current?.creation) throw new Error("Request not confirmed");
      clearPendingProductionCreation(sessionStorage, saved);
      setPending(null);
      setState(current);
      accepted.current();
    } catch (cause) {
      if (!active.signal.aborted)
        setError(
          cause instanceof ProductionCreationError
            ? cause.message
            : "This request could not be confirmed. Reopen this review to check its saved status; retry keeps the same request.",
        );
    } finally {
      if (!active.signal.aborted) setBusy(false);
    }
  }
  const creation = state?.creation;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up Production</DialogTitle>
          <DialogDescription>
            A separate database for this project, on the private PostgreSQL
            server connected to this instance.
          </DialogDescription>
        </DialogHeader>
        <ol className="grid gap-3">
          {PHASES.map((label, index) => (
            <li key={label} className="flex items-center gap-3">
              <span className="text-[var(--color-text-3)]">
                {creation && index < creation.completedPhases.length
                  ? "✓"
                  : String(index + 1).padStart(2, "0")}
              </span>
              {label}
            </li>
          ))}
        </ol>
        <p className="text-[var(--color-text-2)]">
          After setup, Wrenly checks the database connection before marking it
          ready. Development data stays separate.
        </p>
        {creation ? (
          <p role="status">
            {creation.status === "needs_review"
              ? "Setup needs review. Your saved request is preserved."
              : `Saved setup: ${creation.status}`}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="database-attention">
            {error}
          </p>
        ) : null}
        {state && !state.connectionId && !creation ? (
          <a href="/settings/connections">
            Connect the Production server in Settings →
          </a>
        ) : null}
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {!creation || pending ? (
            <Button
              disabled={busy || (!pending && !state?.connectionId)}
              onClick={() => {
                void submit();
              }}
            >
              {busy
                ? "Saving request…"
                : pending
                  ? "Retry saved request"
                  : "Create Production database"}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
