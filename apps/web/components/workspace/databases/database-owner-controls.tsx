"use client";
/** Owner-confirmed lifecycle requests retain an actor-scoped recovery identity before any network write. */
import { useEffect, useRef, useState } from "react";
import type {
  DatabaseRecoveryReview,
  DatabaseResourceStatus,
} from "@wrenly/db/app-database-resource-contract";
import type {
  DatabaseAction,
  DatabaseRecoveryAction,
  DatabaseActionAcknowledgement,
} from "@wrenly/db/app-database-action-contract";
import {
  DatabaseCommandError,
  lookupDatabaseAction,
  submitDatabaseAction,
} from "@/lib/databases/commands";
import {
  readPendingDatabaseAction,
  savePendingDatabaseAction,
  clearPendingDatabaseAction,
  type PendingDatabaseAction,
} from "@/lib/databases/pending-action";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DatabaseRecoveryReviewPanel,
  DATABASE_RECOVERY_LABELS,
} from "./database-recovery-review";
import {
  DatabaseMigrationReviewPanel,
  type ReviewedDatabaseMigration,
} from "./database-migration-review";
import {
  DatabaseIcon,
  PlayIcon,
  SquareIcon,
  ArchiveIcon,
  ListChecksIcon,
  ArrowRightIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
type Environment = "development" | "production";
type Kind = DatabaseAction["kind"];
// These failures are known to precede provisioning; the server still rechecks exact resource state.
const RETRYABLE_CREATION_ERRORS = new Set([
  "PREREQUISITE_UNAVAILABLE",
  "ACTOR_ACCESS_CHANGED",
  "RECOVERED_BEFORE_EFFECT",
]);
const LABELS: Record<Kind, string> = {
  create: "Create Development database",
  start: "Start database",
  stop: "Stop database",
  backup: "Create verified backup",
  migrate: "Review database changes",
};
const ACTION_ICONS = {
  create: DatabaseIcon,
  start: PlayIcon,
  stop: SquareIcon,
  backup: ArchiveIcon,
  migrate: ListChecksIcon,
};
const EXPLANATIONS: Record<Kind, string> = {
  migrate:
    "Review the selected saved revision, choose a verified backup, then explicitly confirm admission. Execution rehearses changes before touching this database.",
  create:
    "Create a private PostgreSQL resource for this project. Its data stays separate from Wrenly’s accounts and project history.",
  start:
    "Start the existing database. This does not rerun migrations or restart an application.",
  stop: "Stop this database runtime while keeping its saved data. Active application work must finish first.",
  backup:
    "Create an encrypted backup and verify it by restoring a separate disposable copy. Existing application data is preserved.",
};

/** Parent keys by actor/project; closing the dialog preserves pending admission across navigation and reload. */
export function DatabaseOwnerControls({
  projectId,
  actorId,
  status,
  environment,
  selectedBuildId,
  selectedBuildSuccessful = false,
  initialAction = null,
  unavailable = false,
  onClose,
  onReload,
  onAccepted,
}: {
  projectId: string;
  actorId: string;
  status: DatabaseResourceStatus;
  environment: Environment | null;
  unavailable?: boolean;
  selectedBuildId?: string;
  selectedBuildSuccessful?: boolean;
  initialAction?: "start" | "stop" | null;
  onClose: () => void;
  onReload: () => void;
  onAccepted: (receipt: DatabaseActionAcknowledgement) => void;
}): React.JSX.Element {
  const [recovery, setRecovery] = useState<DatabaseRecoveryReview | null>(null);
  const [recoveryOperation, setRecoveryOperation] = useState<string | null>(
    null,
  );
  const [migration, setMigration] = useState<ReviewedDatabaseMigration | null>(
    null,
  );
  const [restored, setRestored] = useState(false),
    [storageError, setStorageError] = useState(false);
  const [pending, setPending] = useState<PendingDatabaseAction | null>(null);
  const [choice, setChoice] = useState<Kind | null>(initialAction),
    [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false),
    [notice, setNotice] = useState("");
  const busyRef = useRef(false),
    request = useRef<AbortController | null>(null);
  useEffect(() => {
    try {
      setPending(readPendingDatabaseAction(sessionStorage, actorId, projectId));
    } catch {
      setStorageError(true);
    }
    setRestored(true);
    return () => request.current?.abort();
  }, [actorId, projectId]);
  useEffect(() => {
    if (environment === null && !pending && !busy) {
      setChoice(null);
      setMigration(null);
      setRecovery(null);
      setRecoveryOperation(null);
      setNotice("");
    }
  }, [environment, pending, busy]);
  const selected =
    pending && "environment" in pending.action
      ? pending.action.environment
      : environment;
  const resource = status.resources.find((item) =>
    pending?.resourceId
      ? item.id === pending.resourceId
      : item.environment === selected,
  );
  const interruptions = status.operations.filter(
    (operation) =>
      operation.databaseId === resource?.id &&
      operation.status === "interrupted",
  );
  const active =
    resource &&
    status.operations.some(
      (operation) =>
        operation.databaseId === resource.id &&
        (operation.status === "queued" || operation.status === "running"),
    );
  const close = (): void => {
    if (!busyRef.current) {
      setDismissed(true);
      setChoice(null);
      setMigration(null);
      setNotice("");
      setRecovery(null);
      setRecoveryOperation(null);
      onClose();
    }
  };
  const accept = (
    saved: PendingDatabaseAction,
    receipt: DatabaseActionAcknowledgement,
  ): void => {
    if (saved.resourceId !== null && receipt.resourceId !== saved.resourceId)
      throw new Error("Acknowledgement resource changed");
    clearPendingDatabaseAction(sessionStorage, saved);
    setPending(null);
    setChoice(null);
    setNotice("");
    onClose();
    onAccepted(receipt);
  };
  const perform = async (
    mode: "submit" | "lookup" | "retry",
  ): Promise<void> => {
    if (
      busyRef.current ||
      !restored ||
      storageError ||
      !status.capabilities.manage ||
      (unavailable && mode !== "lookup")
    )
      return;
    const existing = pending;
    let saved = existing;
    try {
      if (!saved) {
        if (
          mode !== "submit" ||
          (!choice && !recovery) ||
          selected !== "development"
        )
          return;
        if (
          choice === "migrate" &&
          (!selectedBuildSuccessful ||
            !migration ||
            migration.review.revision !== resource?.revision ||
            migration.review.buildId !== selectedBuildId)
        )
          return;
        let action: DatabaseAction | DatabaseRecoveryAction;
        if (recovery) {
          const kind = recovery.choices[0];
          if (
            !kind ||
            recovery.resourceId !== resource?.id ||
            recovery.revision !== resource.revision
          )
            return;
          action = {
            requestId: crypto.randomUUID(),
            kind,
            operationId: recovery.operationId,
            expectedRevision: recovery.revision,
            confirmRecovery: true,
          };
        } else {
          if (!choice) return;
          action = {
            requestId: crypto.randomUUID(),
            kind: choice,
            environment: "development",
            expectedRevision: resource?.revision ?? null,
            ...(choice === "migrate" && migration
              ? {
                  buildId: migration.review.buildId,
                  backupId: migration.backupId,
                  migrationDigest: migration.review.migrationDigest,
                  confirmChanges: true as const,
                }
              : {}),
          };
        }
        saved = {
          version: 1,
          projectId,
          actorId,
          resourceId: resource?.id ?? null,
          action,
        };
        savePendingDatabaseAction(sessionStorage, saved);
        setPending(saved);
      }
    } catch {
      setStorageError(true);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setNotice("");
    const controller = new AbortController();
    request.current = controller;
    try {
      if (mode === "lookup") {
        const receipt = await lookupDatabaseAction(
          projectId,
          saved.action.requestId,
          controller.signal,
          undefined,
          "confirmRecovery" in saved.action,
        );
        if (receipt) accept(saved, receipt);
        else
          setNotice(
            "No saved acknowledgement is confirmed yet. An earlier request may still finish. Retry only this same request.",
          );
      } else
        accept(
          saved,
          await submitDatabaseAction(
            projectId,
            saved.action,
            controller.signal,
          ),
        );
    } catch (error) {
      if (
        !existing &&
        error instanceof DatabaseCommandError &&
        error.rejected
      ) {
        try {
          clearPendingDatabaseAction(sessionStorage, saved);
          setPending(null);
          setChoice(null);
        } catch {
          setStorageError(true);
        }
        setNotice(
          "The request was not accepted. Reload database status before reviewing another action.",
        );
      } else
        setNotice(
          "The request is unconfirmed. Check its saved acknowledgement or retry the identical request. Do not start another action.",
        );
    } finally {
      busyRef.current = false;
      setBusy(false);
      request.current = null;
    }
  };
  const available: Kind[] =
    !resource ||
    (resource.status === "failed" &&
      RETRYABLE_CREATION_ERRORS.has(resource.errorCode ?? ""))
      ? ["create"]
      : resource.status === "stopped"
        ? ["start"]
        : resource.status === "ready"
          ? ["backup", "stop", ...(selectedBuildId ? ["migrate" as const] : [])]
          : [];
  const open =
    restored && (environment !== null || Boolean(pending && !dismissed));
  return (
    <>
      {storageError ? (
        <p className="database-attention" role="status">
          Saved request recovery is unavailable. Browser session storage must be
          accessible before managing databases.
        </p>
      ) : null}
      {pending && !open ? (
        <div className="database-attention" role="status">
          A database request needs acknowledgement.
          <Button variant="outline" onClick={() => setDismissed(false)}>
            Review saved request
          </Button>
        </div>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent className="database-command-dialog">
          <DialogTitle>
            {pending
              ? "Check your database request"
              : choice
                ? LABELS[choice]
                : selected === "production"
                  ? "Production database"
                  : "Manage Development"}
          </DialogTitle>
          <DialogDescription>
            {pending
              ? "A saved request is not proof that execution succeeded. Its identity stays fixed until acknowledgement is verified."
              : choice
                ? EXPLANATIONS[choice]
                : "Review the current resource before choosing an action. Nothing runs until you confirm."}
          </DialogDescription>
          {storageError ? (
            <p role="alert">
              Commands are blocked until saved-request storage is available.
            </p>
          ) : pending ? (
            <div className="database-command-details">
              <p>
                {"confirmRecovery" in pending.action
                  ? DATABASE_RECOVERY_LABELS[pending.action.kind]
                  : LABELS[pending.action.kind]}
              </p>
              <p className="database-muted">
                Request <code>{pending.action.requestId}</code>
              </p>
            </div>
          ) : selected === "production" ? (
            <p className="database-view-message">
              Production needs a separately configured and verified private
              provider. These local controls manage Development only; no data is
              copied automatically.
            </p>
          ) : active ? (
            <p className="database-view-message">
              A database operation is already queued or running. Check recent
              activity before submitting another.
            </p>
          ) : resource &&
            (resource.status === "recovery_required" ||
              interruptions.length > 0) &&
            !recovery ? (
            <div className="database-command-choices">
              {!recoveryOperation ? (
                interruptions.map((operation) => (
                  <Button
                    key={operation.id}
                    variant="outline"
                    onClick={() => setRecoveryOperation(operation.id)}
                  >
                    Inspect interrupted {operation.kind}
                  </Button>
                ))
              ) : (
                <DatabaseRecoveryReviewPanel
                  key={`${resource.id}:${resource.revision}:${recoveryOperation}`}
                  projectId={projectId}
                  resourceId={resource.id}
                  revision={resource.revision}
                  operationId={recoveryOperation}
                  onConfirm={setRecovery}
                />
              )}
            </div>
          ) : !choice && !notice && !recovery ? (
            <div className="database-command-choices">
              {available.map((kind) => {
                const Icon = ACTION_ICONS[kind];
                return (
                  <button
                    type="button"
                    key={kind}
                    disabled={
                      unavailable ||
                      (kind === "migrate" && !selectedBuildSuccessful)
                    }
                    className="database-command-choice"
                    aria-label={LABELS[kind]}
                    onClick={() => {
                      setChoice(kind);
                      setMigration(null);
                      setNotice("");
                    }}
                  >
                    <span className="database-command-icon">
                      <Icon size={19} aria-hidden="true" />
                    </span>
                    <span>
                      <strong>{LABELS[kind]}</strong>
                      <small>
                        {kind === "migrate" && !selectedBuildSuccessful
                          ? "A successful saved revision is required. Fix the failed build before reviewing database changes."
                          : EXPLANATIONS[kind]}
                      </small>
                    </span>
                    <ArrowRightIcon size={15} aria-hidden="true" />
                  </button>
                );
              })}
              {!available.length ? (
                <p>
                  This resource needs its interrupted operation reviewed before
                  more work can start.
                </p>
              ) : null}
            </div>
          ) : null}
          {!pending &&
          choice === "migrate" &&
          selectedBuildSuccessful &&
          resource &&
          selectedBuildId &&
          !migration ? (
            <DatabaseMigrationReviewPanel
              key={`${projectId}:${resource.id}:${resource.revision}:${selectedBuildId}`}
              projectId={projectId}
              resourceId={resource.id}
              revision={resource.revision}
              buildId={selectedBuildId}
              onConfirm={setMigration}
            />
          ) : null}
          {!pending && recovery ? (
            <p>
              Confirm inspection or cleanup of this exact interrupted operation.
              The old action will not run again.
            </p>
          ) : null}
          {!pending && migration ? (
            <p>
              Reviewed revision and backup selected. Confirm below to submit
              these exact database changes.
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="database-view-message">
              {notice}
            </p>
          ) : null}
          {unavailable ? (
            <p role="alert">
              Current status is unavailable.{" "}
              <Button variant="outline" onClick={onReload}>
                Refresh database status
              </Button>
            </p>
          ) : null}
          <DialogFooter className="database-command-footer">
            {!pending && (choice || recoveryOperation) ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setChoice(null);
                  setMigration(null);
                  setRecovery(null);
                  setRecoveryOperation(null);
                  setNotice("");
                }}
              >
                Back to actions
              </Button>
            ) : null}
            <Button variant="ghost" disabled={busy} onClick={close}>
              Close
            </Button>
            {pending && !storageError ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void perform("lookup")}
                >
                  Check saved action
                </Button>
                <Button
                  disabled={busy || unavailable}
                  onClick={() => void perform("retry")}
                >
                  Retry same request
                </Button>
              </>
            ) : notice ? (
              <Button
                disabled={busy}
                onClick={() => {
                  close();
                  onReload();
                }}
              >
                Reload status
              </Button>
            ) : recovery && !storageError && !active ? (
              <Button
                disabled={busy || unavailable}
                onClick={() => void perform("submit")}
              >
                Confirm recovery
              </Button>
            ) : choice &&
              (choice !== "migrate" || migration !== null) &&
              selected === "development" &&
              !active &&
              !storageError ? (
              <Button
                disabled={busy || unavailable}
                onClick={() => void perform("submit")}
              >
                Confirm {choice === "backup" ? "backup" : choice}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
