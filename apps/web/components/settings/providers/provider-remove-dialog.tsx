"use client";
// Confirmation dialog for permanently removing a saved provider connection.
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  parseProviderRemoval,
  providerSettingsRequest,
  type ProviderConnection,
} from "@/lib/models/provider-settings";

/** Confirms impact and enforces blocker guidance before deleting a provider connection. */
export function ProviderRemoveDialog({
  connection,
  defaultModel,
  open,
  onOpenChange,
  onRemoved,
}: {
  connection: ProviderConnection | null;
  defaultModel: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved: (
    result: { deleted: true; clearedInstanceDefault: boolean },
    removedLabel: string,
  ) => void;
}): React.JSX.Element {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setConfirmRemove(false);
    setError("");
  }, [connection?.id, open]);

  if (!connection) {
    return <Dialog open={false} onOpenChange={onOpenChange} />;
  }

  const boundProjectCount = connection.boundProjectCount ?? 0;

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const result = parseProviderRemoval(
        await providerSettingsRequest("/api/models/connections", "DELETE", {
          id: connection.id,
        }),
      );
      setConfirmRemove(false);
      onOpenChange(false);
      onRemoved(result, connection.label);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Connection could not be removed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove {connection.label}?</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {connection.endpoint}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-xs leading-relaxed text-[var(--color-text-2)]">
          <p>
            Removing this connection permanently erases its saved encrypted
            credentials while keeping an audit record of the removal.
          </p>
          {defaultModel && (
            <p className="rounded-lg bg-[var(--color-surface-2)] p-3 text-[var(--color-text-1)]">
              This connection is the current instance default (
              <code className="break-all">{defaultModel}</code>). Removing it
              clears the instance default for new requests.
            </p>
          )}
          {connection.envSourceId && (
            <p className="rounded-lg bg-[var(--color-surface-2)] p-3 text-[var(--color-text-1)]">
              Imported from server environment (
              <code className="break-all">{connection.envSourceId}</code>). If
              those environment variables stay set on the API server, the
              read-only environment fallback will reappear.
            </p>
          )}
          {boundProjectCount > 0 ? (
            <p
              role="status"
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 font-medium text-[var(--color-text-1)]"
            >
              Assigned as the project model for {boundProjectCount}{" "}
              {boundProjectCount === 1 ? "project" : "projects"}. Switch{" "}
              {boundProjectCount === 1 ? "that project" : "those projects"} to
              another model in Project Settings before removing this connection.
            </p>
          ) : (
            <label className="flex items-start gap-2.5 text-xs text-[var(--color-text-1)]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmRemove}
                disabled={busy}
                onChange={(event) => setConfirmRemove(event.target.checked)}
              />
              <span>
                I understand this permanently removes the saved credentials for{" "}
                {connection.label}.
              </span>
            </label>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-[var(--color-error)]">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || boundProjectCount > 0 || !confirmRemove}
            onClick={() => {
              void remove();
            }}
          >
            {busy ? "Removing…" : "Remove connection"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
