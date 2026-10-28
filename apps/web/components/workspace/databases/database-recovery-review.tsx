"use client";
/** Explicit recovery inspects or cleans owned resources; it never repeats an interrupted migration. */
import { useEffect, useState } from "react";
import type { DatabaseRecoveryReview } from "@wrenly/db/app-database-resource-contract";
import { requestDatabaseRecoveryReview } from "@/lib/databases/requests";
import { Button } from "@/components/ui/button";
export const DATABASE_RECOVERY_LABELS = {
  "recover-before-effect": "Resolve work that never started",
  "recover-runtime-state": "Inspect the saved runtime state",
  "recover-read": "Clean up an interrupted table read",
  "recover-validation": "Clean up an interrupted application check",
} as const;
/** Server review chooses the recovery path from durable evidence; callers cannot infer it from a label. */
export function DatabaseRecoveryReviewPanel({ projectId, resourceId, revision, operationId, onConfirm }: {
  projectId: string; resourceId: string; revision: string; operationId: string;
  onConfirm: (review: DatabaseRecoveryReview) => void;
}): React.JSX.Element {
  const [review, setReview] = useState<DatabaseRecoveryReview | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void requestDatabaseRecoveryReview(projectId, resourceId, operationId, controller.signal)
      .then(value => { if (!controller.signal.aborted) { if (value.revision !== revision) setFailed(true); else setReview(value); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [projectId, resourceId, revision, operationId]);
  if (failed) return <p role="alert">Recovery review could not be verified. Close and reload database status.</p>;
  if (!review) return <p role="status">Checking the interrupted operation’s saved evidence…</p>;
  const kind = review.choices[0];
  if (!kind) return <p>This operation cannot be recovered automatically from its saved evidence. Its database remains protected. Operator inspection is required; do not repeat the old action.</p>;
  return <div><p>{DATABASE_RECOVERY_LABELS[kind]}</p>
    <p>This checks owned resources without repeating the old request. Recovery can still be refused if an executor is active or external resource checks fail. It does not prove the interrupted action succeeded.</p>
    <Button variant="outline" onClick={() => onConfirm(review)}>Review this recovery action</Button></div>;
}
