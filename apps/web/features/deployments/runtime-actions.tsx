"use client";
/** Owner controls keep the exact pending action in this browser; receipt checks never repeat host work. */
import { useEffect, useState } from "react";
import {
  MaintenanceControl,
  MaintenanceControlReceipt,
  type MaintenanceView,
} from "@wrenly/db/production-maintenance-contract";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
const REQUEST_TIMEOUT_MS = 10_000;
export function PublishedRuntimeActions({
  projectId,
  deploymentId,
  actorId,
  view,
  disabled,
  onPending,
  onUpdated,
}: {
  projectId: string;
  deploymentId: string;
  actorId: string;
  view: MaintenanceView;
  disabled: boolean;
  onPending: (pending: boolean) => void;
  onUpdated: () => Promise<unknown>;
}): React.JSX.Element {
  const endpoint =
    `/api/projects/${projectId}/deployments/${deploymentId}/maintenance/controls` as const;
  const key = `wrenly:runtime-control:${actorId}:${projectId}:${deploymentId}`;
  const [pending, setPending] = useState<
    MaintenanceControl | "unreadable" | null
  >(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? MaintenanceControl.parse(JSON.parse(raw)) : null;
    } catch {
      return "unreadable";
    }
  });
  const [choice, setChoice] = useState<MaintenanceControl["kind"] | null>(null),
    [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MaintenanceControlReceipt | null>(null),
    [message, setMessage] = useState("");
  useEffect(() => {
    onPending(pending !== null);
    return () => onPending(false);
  }, [pending, onPending]);
  async function send(
    action: MaintenanceControl,
    lookup = false,
  ): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      const response = await apiFetch(
        lookup ? `${endpoint}/${action.requestId}` : endpoint,
        lookup
          ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(action),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            },
      );
      if (!response.ok)
        throw new Error(
          lookup && response.status === 404
            ? "No saved action was found. This does not prove it was unsaved. Check again or retry the same action."
            : "The action could not be confirmed. Check its saved result before doing anything again.",
        );
      const saved = MaintenanceControlReceipt.parse(await response.json());
      if (saved.requestId !== action.requestId || saved.kind !== action.kind)
        throw new Error("Saved result does not match this action.");
      setResult(saved);
      await onUpdated();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Runtime control could not be confirmed.",
      );
    } finally {
      setBusy(false);
    }
  }
  function confirm(): void {
    if (!choice || pending || disabled) return;
    const action = MaintenanceControl.parse({
      requestId: crypto.randomUUID(),
      expectedAccessRevision: view.accessRevision,
      expectedGrantRevision: view.grantRevision,
      kind: choice,
      confirmRuntimeControl: true,
    });
    try {
      localStorage.setItem(key, JSON.stringify(action));
      setPending(action);
      setChoice(null);
      void send(action);
    } catch {
      setMessage("Browser storage is unavailable. Nothing was sent.");
    }
  }
  function acknowledge(): void {
    if (!result || result.status === "running") return;
    try {
      localStorage.removeItem(key);
      setPending(null);
      setResult(null);
      void onUpdated();
    } catch {
      setMessage(
        "The saved browser action could not be cleared. Keep its receipt before continuing.",
      );
    }
  }
  return (
    <section
      className="grid gap-3 border-t border-[var(--color-border-1)] pt-4"
      aria-label="Published app controls"
    >
      <h3 className="font-medium">Published app</h3>
      <p className="text-sm text-[var(--color-text-3)]">
        Stop pauses maintenance before stopping this exact app and connection.
        Your database and saved storage are preserved.
      </p>
      {!pending ? (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            disabled={disabled || busy || view.attempt?.status === "running"}
            onClick={() => setChoice("stop")}
          >
            Stop published app
          </Button>
          {view.grantRevision ? (
            <Button
              variant="ghost"
              disabled={disabled || busy || view.attempt?.status === "running"}
              onClick={() => setChoice("inspect")}
            >
              Inspect saved runtime
            </Button>
          ) : null}
        </div>
      ) : null}
      {choice && !pending ? (
        <div className="grid gap-3 rounded-xl border border-[var(--color-border-2)] p-4">
          <p>
            {choice === "stop"
              ? "Pause automatic restarts and stop this publication? No database, container or volume will be deleted."
              : "Inspect the original containers and published revision? This starts nothing and sends no app credentials. Unverifiable results stay blocked."}
          </p>
          <div className="flex gap-3">
            <Button disabled={disabled || busy} onClick={confirm}>
              Confirm {choice === "stop" ? "Stop" : "inspection"}
            </Button>
            <Button variant="ghost" onClick={() => setChoice(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {pending && pending !== "unreadable" ? (
        <div className="grid gap-3 rounded-xl bg-[var(--color-surface-2)] p-4">
          <p role="status">
            {result
              ? `Saved ${result.kind}: ${result.status}`
              : "This action is awaiting a confirmed result."}
          </p>
          {result?.status === "interrupted" ? (
            <p className="text-sm">
              The saved attempt needs review. After keeping this result, inspect
              the original runtime or explicitly stop it. Wrenly will not repeat
              the uncertain step.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void send(pending, true)}
            >
              Check saved action
            </Button>
            {!result ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void send(pending)}
              >
                Retry same action
              </Button>
            ) : null}
            {result && result.status !== "running" ? (
              <Button disabled={busy} onClick={acknowledge}>
                Keep result and return to controls
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {pending === "unreadable" ? (
        <p role="alert">
          The saved runtime action could not be read. Restore browser storage
          before sending another action.
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
