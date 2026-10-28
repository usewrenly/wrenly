"use client";
// Imports an existing server credential without returning it to the browser.
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  providerSettingsRequest,
  type EnvironmentProvider,
} from "@/lib/models/provider-settings";
/** Explicitly copies an existing server credential without receiving or storing that credential in the browser. */
export function ImportEnvironmentProvider({
  provider,
  imported,
  onChanged,
}: {
  provider: EnvironmentProvider;
  imported: boolean;
  onChanged: () => void;
}): React.JSX.Element {
  const requestId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const importProvider = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      requestId.current ??= crypto.randomUUID();
      await providerSettingsRequest("/api/models/connections", "POST", {
        source: "environment",
        envSourceId: provider.id,
        reviewVersion: provider.reviewVersion,
        requestId: requestId.current,
      });
      onChanged();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The existing provider could not be imported.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{provider.label}</p>
          <p className="mt-1 text-xs text-[var(--color-text-3)]">
            {imported
              ? "Imported · manage its saved connection above"
              : "Environment configuration · read-only compatibility connection"}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy || imported}
          onClick={() => {
            void importProvider();
          }}
        >
          {imported ? "Imported" : busy ? "Importing…" : "Import connection"}
        </Button>
      </div>
      <p className="break-all font-mono text-xs text-[var(--color-text-2)]">
        {provider.endpoint}
      </p>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
