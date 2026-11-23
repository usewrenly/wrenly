"use client";
/** A saved inspection never continues setup on its own; both actions are explicit and retain their original request after a lost reply. */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  readProductionCreation,
  type ProductionCreationState,
} from "@/lib/databases/production-creation";
import {
  readPendingProductionRecovery,
  savePendingProductionRecovery,
  clearPendingProductionRecovery,
  productionRecoveryAcknowledged,
  submitProductionRecovery,
  type PendingProductionRecovery,
} from "@/lib/databases/production-recovery";
const POLL_MS = 1500;
export function ProductionSetupRecovery({
  actorId,
  projectId,
  state,
  onChange,
}: {
  actorId: string;
  projectId: string;
  state: ProductionCreationState;
  onChange: (state: ProductionCreationState) => void;
}): React.JSX.Element {
  const [pending, setPending] = useState<PendingProductionRecovery | null>(
      null,
    ),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  const change = useRef(onChange),
    controller = useRef<AbortController | null>(null);
  change.current = onChange;
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh(): Promise<void> {
      try {
        const saved = readPendingProductionRecovery(
          sessionStorage,
          actorId,
          projectId,
        );
        const current = await readProductionCreation(projectId, active.signal);
        if (active.signal.aborted || !current) return;
        change.current(current);
        if (saved && productionRecoveryAcknowledged(saved, current)) {
          clearPendingProductionRecovery(sessionStorage, saved);
          setPending(null);
          setError(null);
        } else setPending(saved);
        if (
          current.review &&
          ["queued", "checking"].includes(current.review.status)
        )
          timer = setTimeout(() => {
            void refresh();
          }, POLL_MS);
      } catch {
        if (!active.signal.aborted)
          setError(
            "Recovery status could not be confirmed. Keep the saved request and check again.",
          );
      }
    }
    void refresh();
    return () => {
      active.abort();
      if (timer) clearTimeout(timer);
    };
  }, [actorId, projectId, reload]);
  async function perform(): Promise<void> {
    const active = controller.current;
    if (!active || active.signal.aborted || busy || !state.creation) return;
    setBusy(true);
    try {
      const existing = readPendingProductionRecovery(
        sessionStorage,
        actorId,
        projectId,
      );
      const canContinue =
        state.review &&
        ["confirmed", "absent"].includes(state.review.status) &&
        !state.review.resumedRequestId;
      const saved: PendingProductionRecovery = existing ?? {
        actorId,
        projectId,
        resourceId: state.creation.resourceId,
        input:
          canContinue && state.review
            ? {
                kind: "continue",
                requestId: crypto.randomUUID(),
                expectedRevision: state.projectRevision,
                reviewId: state.review.reviewId,
                confirmContinue: true,
              }
            : {
                kind: "inspect",
                requestId: crypto.randomUUID(),
                expectedRevision: state.projectRevision,
                resourceId: state.creation.resourceId,
                confirmInspect: true,
              },
      };
      savePendingProductionRecovery(sessionStorage, saved);
      setPending(saved);
      await submitProductionRecovery(saved, active.signal);
      if (active.signal.aborted) return;
      clearPendingProductionRecovery(sessionStorage, saved);
      setPending(null);
      setError(null);
      setReload((value) => value + 1);
    } catch {
      if (!active.signal.aborted)
        setError(
          "The recovery request could not be confirmed. Check its status or retry this same request.",
        );
    } finally {
      if (!active.signal.aborted) setBusy(false);
    }
  }
  const reviewing =
    state.review && ["queued", "checking"].includes(state.review.status);
  return (
    <div className="grid gap-3 rounded-xl border border-[var(--color-border-2)] p-4">
      <strong>Review interrupted setup</strong>
      <p className="text-[var(--color-text-2)]">
        Inspection checks the saved phase without repeating SQL. Continuing
        remaining setup requires a separate confirmation.
      </p>
      {state.review ? (
        <p role="status">Inspection: {state.review.status}</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setReload((value) => value + 1)}
        >
          Check saved status
        </Button>
        <Button
          disabled={busy || Boolean(reviewing)}
          onClick={() => {
            void perform();
          }}
        >
          {busy
            ? "Saving…"
            : pending
              ? "Retry saved recovery"
              : state.review &&
                  ["confirmed", "absent"].includes(state.review.status) &&
                  !state.review.resumedRequestId
                ? "Continue remaining setup"
                : "Inspect saved phase"}
        </Button>
      </div>
    </div>
  );
}
