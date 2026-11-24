"use client";
// Unified modal for editing connection settings, checking served models, setting defaults, and reviewing image support.
import { useEffect, useState } from "react";
import { CheckIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChoiceSelect } from "@/components/ui/choice-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  parseCatalogResult,
  parseConnectionProbe,
  providerSettingsRequest,
  type ConnectionProbe,
  type ProviderConnection,
} from "@/lib/models/provider-settings";

export type ProviderDialogTab = "general" | "models" | "images";

function parseImageModelIds(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\r\n,]+/)) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

function normalizedUrlOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Manages one provider connection in a focused tabbed dialog instead of inline accordions. */
export function ProviderConnectionDialog({
  connection,
  defaultModel,
  initialTab,
  open,
  onOpenChange,
  onChanged,
}: {
  connection: ProviderConnection | null;
  defaultModel: string | null;
  initialTab: ProviderDialogTab;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<ProviderDialogTab>(initialTab);
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [probe, setProbe] = useState<ConnectionProbe | null>(null);
  const [model, setModel] = useState("");
  const [imageRevision, setImageRevision] = useState<string | undefined>(
    undefined,
  );
  const [imageModels, setImageModels] = useState("");
  const [catalogModels, setCatalogModels] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab, connection?.id, open]);

  useEffect(() => {
    if (!connection) return;
    setLabel(connection.label);
    setEndpoint(connection.endpoint);
    setEnabled(connection.enabled);
    setToken("");
    setModel(defaultModel ?? "");
    setImageRevision(connection.imageInputRevision);
    setImageModels((connection.imageModelIds ?? []).join("\n"));
    setProbe(null);
    setCatalogModels([]);
    setCatalogQuery("");
    setError("");
    setNotice("");
  }, [connection?.id]);

  useEffect(() => {
    if (!connection) return;
    setLabel(connection.label);
    setEndpoint(connection.endpoint);
    setEnabled(connection.enabled);
    if (defaultModel !== null) setModel(defaultModel);
  }, [connection, defaultModel]);

  if (!connection) {
    return <Dialog open={false} onOpenChange={onOpenChange} />;
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Connection settings could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  };

  const trimmedLabel = label.trim();
  const trimmedEndpoint = endpoint.trim().replace(/\/+$/, "");
  const trimmedToken = token.trim();
  const labelChanged = trimmedLabel !== connection.label;
  const endpointChanged = trimmedEndpoint !== connection.endpoint;
  const enabledChanged = enabled !== connection.enabled;
  const tokenProvided = trimmedToken.length > 0;
  const hasGeneralChanges =
    labelChanged || endpointChanged || enabledChanged || tokenProvided;

  const currentOrigin = normalizedUrlOrigin(connection.endpoint);
  const nextOrigin = normalizedUrlOrigin(trimmedEndpoint);
  const originChanged =
    endpointChanged &&
    currentOrigin !== null &&
    nextOrigin !== null &&
    nextOrigin !== currentOrigin;
  const requiresTokenForHostChange =
    originChanged &&
    (connection.tokenConfigured || connection.kind === "cloud") &&
    !tokenProvided;

  const saveGeneral = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void run(async () => {
      const payload: Record<string, unknown> = { id: connection.id };
      if (labelChanged) payload.label = trimmedLabel;
      if (endpointChanged) payload.endpoint = trimmedEndpoint;
      if (tokenProvided) payload.token = trimmedToken;
      if (enabledChanged) payload.enabled = enabled;
      await providerSettingsRequest("/api/models/connections", "PATCH", payload);
      setToken("");
      if (endpointChanged || tokenProvided) setProbe(null);
      setNotice(
        endpointChanged
          ? "Connection updated. Its version rotated cleanly; check models before setting a default."
          : tokenProvided
            ? "Connection updated and token replaced. Check the connection to verify access."
            : "Connection settings saved.",
      );
      onChanged();
    });
  };

  const check = (): Promise<void> =>
    run(async () => {
      setProbe(null);
      setProbe(
        parseConnectionProbe(
          await providerSettingsRequest(
            "/api/models/connections/probe",
            "POST",
            { id: connection.id },
          ),
        ),
      );
    });

  const saveDefault = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void run(async () => {
      await providerSettingsRequest("/api/models/default", "PUT", {
        connectionId: connection.id,
        modelId: model.trim(),
      });
      setNotice(
        "Instance default saved. New requests use it unless a browser or project choice overrides it.",
      );
      onChanged();
    });
  };

  const searchModels = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void run(async () => {
      const result = parseCatalogResult(
        await providerSettingsRequest(
          `/api/models/catalog?provider=${encodeURIComponent(connection.catalogProviderId!)}&q=${encodeURIComponent(catalogQuery)}&limit=40`,
        ),
      );
      setCatalogModels(result.models);
      setNotice(
        `${result.totalModels} catalog matches. These are metadata, not proof of access for your token.`,
      );
    });
  };

  const selectedImageSet = new Set(parseImageModelIds(imageModels));
  const availableImageModels = [
    ...new Set([
      ...(probe?.state === "ready" ? probe.models : []),
      ...(defaultModel ? [defaultModel] : []),
      ...catalogModels.map((item) => item.id),
    ]),
  ];
  const toggleImageModel = (id: string): void => {
    const next = new Set(selectedImageSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setImageModels([...next].join("\n"));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <DialogTitle className="pr-0">{connection.label}</DialogTitle>
            <span className="provider-saved-badge">
              {connection.kind === "local" ? "Local" : "Hosted"}
            </span>
            <span
              className="provider-saved-badge"
              data-state={connection.enabled ? "enabled" : "disabled"}
            >
              {connection.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <DialogDescription className="break-all font-mono text-xs">
            {connection.endpoint} · {connection.protocol}
          </DialogDescription>
        </DialogHeader>

        <div className="provider-dialog-tabs" role="tablist" aria-label="Connection settings">
          {(
            [
              ["general", "Edit settings"],
              ["models", "Models & default"],
              ["images", "Image inputs"],
            ] as const
          ).map(([value, title]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => {
                setTab(value);
                setError("");
                setNotice("");
              }}
            >
              {title}
            </button>
          ))}
        </div>

        {tab === "general" && (
          <form onSubmit={saveGeneral} className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span>Display name</span>
              <Input
                value={label}
                maxLength={100}
                required
                disabled={busy}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>

            <label className="block space-y-1.5 text-sm">
              <span>Endpoint URL</span>
              <Input
                type="url"
                value={endpoint}
                maxLength={2048}
                required
                disabled={busy}
                onChange={(event) => setEndpoint(event.target.value)}
              />
              <p className="text-xs leading-relaxed text-[var(--color-text-3)]">
                {requiresTokenForHostChange
                  ? "Different host detected — enter the API token below so existing credentials are never sent to another host."
                  : endpointChanged
                    ? "Same host — your saved API token stays intact and the connection version rotates for new requests."
                    : "Fix typos (such as /v2 to /v1) without recreating the connection. Changing the URL rotates its version so active or queued work keeps its original endpoint."}
              </p>
            </label>

            <label className="block space-y-1.5 text-sm">
              <span>New token</span>
              <Input
                type="password"
                autoComplete="new-password"
                value={token}
                maxLength={8192}
                disabled={busy}
                onChange={(event) => setToken(event.target.value)}
                placeholder={
                  requiresTokenForHostChange
                    ? "Required when changing to a new host"
                    : connection.tokenConfigured
                      ? "Leave blank to keep saved token"
                      : "Optional API token"
                }
              />
              <p className="text-xs leading-relaxed text-[var(--color-text-3)]">
                Saved tokens are never returned to the browser. Entering a new
                token replaces the encrypted credential on save.
              </p>
            </label>

            <label className="flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                disabled={busy}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span>
                Enabled for new conversations and builds (existing queued work
                keeps its state)
              </span>
            </label>

            <DialogFooter className="justify-between gap-2 pt-2">
              <Button
                type="submit"
                disabled={
                  busy ||
                  !trimmedLabel ||
                  !trimmedEndpoint ||
                  !hasGeneralChanges ||
                  requiresTokenForHostChange
                }
              >
                Save changes
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
            </DialogFooter>
          </form>
        )}

        {tab === "models" && (
          <div className="space-y-4">
            {defaultModel && (
              <p className="text-sm">
                Default model: <code className="break-all">{defaultModel}</code>
                {!connection.enabled &&
                  " · disabled; enable this connection or choose another default."}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy || !connection.enabled}
                onClick={() => {
                  void check();
                }}
              >
                Check connection
              </Button>
              {!connection.enabled && (
                <span className="text-xs text-[var(--color-text-3)]">
                  Enable this connection in Edit settings before checking
                  models.
                </span>
              )}
            </div>

            {probe && (
              <div
                className="space-y-2 rounded-lg bg-[var(--color-surface-2)] p-3 text-sm"
                role="status"
              >
                {probe.state === "error" ? (
                  <p>{probe.error?.message ?? "The connection check failed."}</p>
                ) : probe.state === "empty" ? (
                  <p>
                    {connection.protocol === "ollama"
                      ? "Ollama is reachable but has no installed models. On the Ollama server, run ollama pull <model-name>, then check again."
                      : "The service is reachable but did not list models. Check your account access or enter an explicit model ID below."}
                  </p>
                ) : (
                  <>
                    <p>
                      {probe.models.length}{" "}
                      {connection.protocol === "ollama" ? "installed" : "served"}{" "}
                      models found. A connection check does not generate an app.
                    </p>
                    <label className="block space-y-2">
                      <span>
                        Choose a{" "}
                        {connection.protocol === "ollama" ? "local" : "served"}{" "}
                        model
                      </span>
                      <ChoiceSelect
                        label={
                          connection.protocol === "ollama"
                            ? "Choose a local model"
                            : "Choose a served model"
                        }
                        searchable
                        searchPlaceholder="Search models…"
                        emptySearchText="No matching models found."
                        value={probe.models.includes(model) ? model : null}
                        disabled={busy}
                        onChange={setModel}
                        displayValue={
                          probe.models.includes(model) ? model : "Select a model"
                        }
                        options={probe.models.map((id) => ({
                          value: id,
                          label: id,
                        }))}
                      />
                    </label>
                  </>
                )}
              </div>
            )}

            {connection.enabled && connection.catalogProviderId && (
              <form onSubmit={searchModels} className="space-y-2">
                <label className="block space-y-1.5 text-sm">
                  <span>Search this provider&apos;s catalog models</span>
                  <div className="flex gap-2">
                    <Input
                      value={catalogQuery}
                      maxLength={200}
                      disabled={busy}
                      onChange={(event) => setCatalogQuery(event.target.value)}
                      placeholder="Model name or ID"
                    />
                    <Button type="submit" variant="outline" disabled={busy}>
                      Search
                    </Button>
                  </div>
                </label>
                {!!catalogModels.length && (
                  <label className="block space-y-1.5 text-sm">
                    <span>Catalog choices · access not verified</span>
                    <ChoiceSelect
                      label="Catalog choices · access not verified"
                      searchable
                      searchPlaceholder="Search catalog models…"
                      emptySearchText="No matching catalog models found."
                      value={
                        catalogModels.some((item) => item.id === model)
                          ? model
                          : null
                      }
                      displayValue={
                        catalogModels.find((item) => item.id === model)?.name ??
                        "Select a catalog model"
                      }
                      disabled={busy}
                      onChange={setModel}
                      options={catalogModels.map((item) => ({
                        value: item.id,
                        label: item.name,
                        description: item.id,
                      }))}
                    />
                  </label>
                )}
              </form>
            )}

            {connection.enabled && (
              <form
                onSubmit={saveDefault}
                className="provider-default-form space-y-3"
              >
                <label className="block space-y-2 text-sm">
                  <span>Model ID for the instance default</span>
                  <Input
                    value={model}
                    required
                    maxLength={512}
                    disabled={busy}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="Choose above or enter an exact model ID"
                  />
                </label>
                <p className="text-xs text-[var(--color-text-3)]">
                  Use the exact ID from this service. A manual or catalog ID is
                  not live-verified; model access is checked when you send a
                  request.
                </p>
                <Button type="submit" disabled={busy || !model.trim()}>
                  Set instance default
                </Button>
              </form>
            )}
          </div>
        )}

        {tab === "images" && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const ids = parseImageModelIds(imageModels);
                await providerSettingsRequest(
                  "/api/models/connections",
                  "PATCH",
                  {
                    id: connection.id,
                    imageModelIds: ids,
                    expectedImageInputRevision: imageRevision,
                  },
                );
                setNotice(
                  "Image support saved. Only these exact model IDs can receive reference images.",
                );
                onChanged();
              });
            }}
          >
            <p className="text-xs leading-relaxed text-[var(--color-text-2)]">
              Plain text files (.txt, .md) work with any model. Select or list
              the exact model IDs on this connection that accept images (one per
              line or comma-separated).
            </p>
            {availableImageModels.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-[var(--color-text-2)]">
                  Quick-toggle models on this connection
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {availableImageModels.map((id) => {
                    const active = selectedImageSet.has(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={active}
                        disabled={busy}
                        onClick={() => toggleImageModel(id)}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                          active
                            ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-primary)]"
                            : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-2)] hover:text-[var(--color-text-1)]"
                        }`}
                      >
                        {active && <CheckIcon size={12} aria-hidden="true" />}
                        <span className="font-mono">{id}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <label className="block space-y-2 text-sm">
              <span>Models that accept images</span>
              {imageRevision !== connection.imageInputRevision && (
                <button
                  type="button"
                  className="block text-xs underline"
                  onClick={() => {
                    setImageModels((connection.imageModelIds ?? []).join("\n"));
                    setImageRevision(connection.imageInputRevision);
                  }}
                >
                  Load the updated image settings before editing again
                </button>
              )}
              <textarea
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-xs"
                rows={4}
                maxLength={51300}
                value={imageModels}
                disabled={busy}
                onChange={(event) => setImageModels(event.target.value)}
                placeholder="Exact model ID, one per line or comma-separated"
              />
            </label>
            <DialogFooter>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !imageRevision ||
                  imageRevision !== connection.imageInputRevision
                }
              >
                Save image support
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
            </DialogFooter>
          </form>
        )}

        {busy && (
          <p role="status" className="text-sm text-[var(--color-text-2)]">
            Updating connection…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-[var(--color-error)]">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-[var(--color-text-1)]">
            {notice}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
