"use client";
/** Owner actions preserve an unresolved exact request across closing, refresh and lost replies. */
import { PublishedRuntimeActions } from "./runtime-actions";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MaintenanceDecision,
  MaintenanceDecisionReceipt,
  MaintenanceView,
} from "@wrenly/db/production-maintenance-contract";
import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth/auth-client";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
const REFRESH_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;
interface Props {
  projectId: string;
  deploymentId: string;
  actorId: string;
}
function PermissionPanel({
  projectId,
  deploymentId,
  actorId,
}: Props): React.JSX.Element {
  const endpoint =
    `/api/projects/${projectId}/deployments/${deploymentId}/maintenance` as const;
  const storageKey = `wrenly:maintenance:${actorId}:${projectId}:${deploymentId}`;
  const [saved, setPending] = useState<
    MaintenanceDecision | "unreadable" | null
  >(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? MaintenanceDecision.parse(JSON.parse(raw)) : null;
    } catch {
      return "unreadable";
    }
  });
  const pending = saved === "unreadable" ? null : saved;
  const storageUnavailable = saved === "unreadable";
  const [runtimePending, setRuntimePending] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [choice, setChoice] = useState<MaintenanceDecision["state"] | null>(
    null,
  );
  const status = useQuery({
    queryKey: ["runtime-maintenance", actorId, projectId, deploymentId],
    refetchInterval: REFRESH_MS,
    retry: false,
    queryFn: async ({ signal }): Promise<MaintenanceView> => {
      const response = await apiFetch(endpoint, {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
      if (!response.ok)
        throw new Error(
          "Maintenance status is unavailable. Only the project owner can change permission.",
        );
      return MaintenanceView.parse(await response.json());
    },
  });
  async function send(
    input: MaintenanceDecision,
    lookup = false,
  ): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      const response = await apiFetch(
        lookup ? `${endpoint}/actions/${input.requestId}` : endpoint,
        lookup
          ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            },
      );
      if (!response.ok)
        throw new Error(
          lookup && response.status === 404
            ? "No receipt was found. This does not prove the decision was unsaved. Retry the same decision or check again."
            : "The decision could not be confirmed. Check its saved receipt before making another change.",
        );
      const receipt = MaintenanceDecisionReceipt.parse(await response.json());
      if (
        receipt.requestId !== input.requestId ||
        receipt.state !== input.state
      )
        throw new Error("The receipt does not match this decision.");
      localStorage.removeItem(storageKey);
      setPending(null);
      setChoice(null);
      setMessage("Permission saved.");
      await status.refetch();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Permission could not be confirmed.",
      );
    } finally {
      setBusy(false);
    }
  }
  function confirm(): void {
    if (
      runtimePending ||
      !choice ||
      !status.data ||
      status.isError ||
      pending ||
      storageUnavailable
    )
      return;
    const input: MaintenanceDecision = {
      requestId: crypto.randomUUID(),
      expectedAccessRevision: status.data.accessRevision,
      expectedGrantRevision: status.data.grantRevision,
      state: choice,
      confirmMaintenance: true,
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(input));
      setPending(input);
      void send(input);
    } catch {
      setMessage("Browser storage is unavailable. Nothing was sent.");
    }
  }
  return (
    <div className="grid gap-5">
      <DialogTitle>Keep this publication running</DialogTitle>
      <DialogDescription>
        Allow Wrenly to restore this exact app and its database connection after
        their containers stop. This permission survives signing out. It cannot
        publish a new version or change your tables.
      </DialogDescription>
      {status.isPending ? (
        <p role="status">Loading permission…</p>
      ) : status.isError ? (
        <p role="alert">{status.error.message}</p>
      ) : (
        <>
          <div className="rounded-xl border border-[var(--color-border-1)] bg-[var(--color-surface-2)] p-4">
            <p>
              Permission: <strong>{status.data.state}</strong>
            </p>
            <p className="mt-2 text-sm">
              Latest check: {status.data.attempt?.status ?? "Not checked yet"}
            </p>
            {status.data.attempt ? (
              <p className="mt-1 text-xs">
                {new Date(status.data.attempt.updatedAt).toLocaleString()}
                {status.data.attempt.step
                  ? ` · ${{ "broker-start": "Database connection", "application-start": "App startup", "route-verify": "Published address", "application-stop": "Stop app", "broker-stop": "Stop connection", "verify-stopped": "Verify stopped", "broker-inspect": "Inspect connection", "application-inspect": "Inspect app", "route-inspect": "Inspect published address" }[status.data.attempt.step]}`
                  : ""}
              </p>
            ) : null}
          </div>
          {status.data.attempt?.status === "interrupted" ? (
            <p role="alert">
              A previous check needs review. Wrenly will not repeat an
              unconfirmed restart. You can still pause or revoke permission.
            </p>
          ) : null}
          {!pending &&
          !storageUnavailable &&
          status.data.state !== "revoked" ? (
            <div className="flex flex-wrap gap-3">
              {status.data.state !== "enabled" ? (
                <Button
                  disabled={busy || runtimePending}
                  onClick={() => setChoice("enabled")}
                >
                  {status.data.state === "paused"
                    ? "Resume maintenance"
                    : "Enable maintenance"}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy || runtimePending}
                  onClick={() => setChoice("paused")}
                >
                  Pause maintenance
                </Button>
              )}
              {status.data.state !== "disabled" ? (
                <Button
                  variant="ghost"
                  disabled={busy || runtimePending}
                  onClick={() => setChoice("revoked")}
                >
                  Revoke permission
                </Button>
              ) : null}
            </div>
          ) : null}
          {status.data.state === "revoked" ? (
            <p>
              Permission was revoked for this publication. A new publication
              needs its own confirmation.
            </p>
          ) : null}
        </>
      )}
      {status.data && !status.isError ? (
        <PublishedRuntimeActions
          projectId={projectId}
          deploymentId={deploymentId}
          actorId={actorId}
          view={status.data}
          disabled={busy || Boolean(pending) || storageUnavailable}
          onPending={setRuntimePending}
          onUpdated={status.refetch}
        />
      ) : null}
      {choice && !pending ? (
        <div className="grid gap-3 rounded-xl border border-[var(--color-border-2)] p-4">
          <p>
            {choice === "enabled"
              ? "Restore only this reviewed publication when needed?"
              : choice === "paused"
                ? "Pause automatic checks? This leaves the currently running app untouched."
                : "Permanently revoke maintenance for this publication? This leaves the running app untouched."}
          </p>
          <div className="flex gap-3">
            <Button disabled={busy || runtimePending} onClick={confirm}>
              Confirm{" "}
              {choice === "enabled"
                ? "maintenance"
                : choice === "paused"
                  ? "pause"
                  : "revocation"}
            </Button>
            <Button variant="ghost" onClick={() => setChoice(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {pending ? (
        <div className="grid gap-3">
          <p>
            A decision is awaiting confirmation. Other changes remain
            unavailable.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={busy || runtimePending}
              onClick={() => void send(pending, true)}
            >
              Check saved decision
            </Button>
            <Button
              variant="ghost"
              disabled={busy || runtimePending}
              onClick={() => void send(pending)}
            >
              Retry same decision
            </Button>
          </div>
        </div>
      ) : null}
      {storageUnavailable ? (
        <p role="alert">
          A saved browser decision could not be read. No new decision will be
          sent. Restore access to this browser’s saved data before continuing.
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
export function MaintenanceControls({
  projectId,
  deploymentId,
}: Omit<Props, "actorId">): React.JSX.Element | null {
  const { data: session } = authClient.useSession();
  const [open, setOpen] = useState(false);
  if (!session?.user.id) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Runtime maintenance
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          {open ? (
            <PermissionPanel
              key={session.user.id}
              projectId={projectId}
              deploymentId={deploymentId}
              actorId={session.user.id}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
