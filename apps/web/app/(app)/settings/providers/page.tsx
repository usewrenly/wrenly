"use client";
// Coordinates owner-reviewed connection setup while server endpoints enforce credential access.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LayoutGridIcon, SearchIcon, TableIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportEnvironmentProvider } from "@/components/settings/providers/import-environment-provider";
import { AddProvider } from "@/components/settings/providers/add-provider";
import {
  ProviderConnectionCard,
  ProviderConnectionTableRow,
} from "@/components/settings/providers/provider-connection";
import {
  ProviderConnectionDialog,
  type ProviderDialogTab,
} from "@/components/settings/providers/provider-connection-dialog";
import { ProviderRemoveDialog } from "@/components/settings/providers/provider-remove-dialog";
import {
  parseProviderSettings,
  providerSettingsRequest,
  ProviderSettingsError,
  type ProviderSettings,
} from "@/lib/models/provider-settings";

type FilterKind = "all" | "local" | "cloud" | "disabled";

export default function ProviderSettingsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<"connect" | "choose">("connect");
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [view, setView] = useState<"grid" | "table">("grid");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");
  const [editing, setEditing] = useState<{
    id: string;
    tab: ProviderDialogTab;
  } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [pageNotice, setPageNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      setBusy(true);
      setError("");
      try {
        const value = parseProviderSettings(
          await providerSettingsRequest(
            "/api/models/connections",
            "GET",
            undefined,
            controller.signal,
          ),
        );
        if (!controller.signal.aborted) {
          setSettings(value);
          setDenied(false);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setSettings(null);
          setDenied(
            failure instanceof ProviderSettingsError &&
              [401, 403].includes(failure.status),
          );
          setError(
            failure instanceof Error
              ? failure.message
              : "Provider settings are unavailable.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [reload]);

  const changed = (): void => {
    setReload((value) => value + 1);
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    void queryClient.invalidateQueries({ queryKey: ["setup-summary"] });
  };

  const toggleEnabled = async (
    id: string,
    label: string,
    currentlyEnabled: boolean,
  ): Promise<void> => {
    setMutatingId(id);
    setActionError("");
    setPageNotice("");
    try {
      await providerSettingsRequest("/api/models/connections", "PATCH", {
        id,
        enabled: !currentlyEnabled,
      });
      setPageNotice(
        currentlyEnabled
          ? `${label} disabled. Queued work cannot switch to another provider.`
          : `${label} enabled.`,
      );
      changed();
    } catch (failure) {
      setActionError(
        failure instanceof Error
          ? failure.message
          : "Connection state could not be updated.",
      );
    } finally {
      setMutatingId(null);
    }
  };

  const defaultConnection = settings?.default
    ? settings.connections.find(
        (connection) => connection.id === settings.default!.connectionId,
      )
    : undefined;

  const query = search.trim().toLocaleLowerCase();
  const visibleConnections =
    settings?.connections.filter((connection) => {
      if (filter === "local" && connection.kind !== "local") return false;
      if (filter === "cloud" && connection.kind !== "cloud") return false;
      if (filter === "disabled" && connection.enabled) return false;
      if (!query) return true;
      const defaultId =
        settings.default?.connectionId === connection.id
          ? settings.default.modelId
          : "";
      return `${connection.label} ${connection.endpoint} ${defaultId}`
        .toLocaleLowerCase()
        .includes(query);
    }) ?? [];

  const editingConnection = editing
    ? (settings?.connections.find((item) => item.id === editing.id) ?? null)
    : null;
  const removingConnection = removingId
    ? (settings?.connections.find((item) => item.id === removingId) ?? null)
    : null;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 px-5 py-10 sm:px-8 sm:py-14">
      <header className="space-y-3">
        <p className="pt-3 text-xs uppercase tracking-widest text-[var(--color-text-3)]">
          Instance configuration
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Models that work for you.
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-[var(--color-text-2)]">
          Connect a provider, check its models, then choose the default for new
          conversations and builds. Credentials stay encrypted on your Wrenly
          instance.
        </p>
      </header>
      {busy && (
        <p role="status" className="text-sm">
          Loading saved providers…
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="space-y-3 rounded-xl border border-[var(--color-border)] p-5"
        >
          <p>{error}</p>
          {denied ? (
            <p className="text-sm">
              Only the instance owner can manage shared credentials. Members can
              choose enabled models in settings.{" "}
              <a href="/sign-in" className="underline">
                Sign in
              </a>{" "}
              with the owner account if you manage this instance.
            </p>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setReload((value) => value + 1)}
            >
              Try again
            </Button>
          )}
        </div>
      )}
      {settings && (
        <>
          <nav className="provider-steps" aria-label="Provider setup stages">
            <button
              type="button"
              aria-pressed={stage === "connect"}
              onClick={() => setStage("connect")}
            >
              <span>01</span>
              <strong>Connect a provider</strong>
              <small>Add the service that runs your models.</small>
            </button>
            <button
              type="button"
              aria-pressed={stage === "choose"}
              onClick={() => setStage("choose")}
            >
              <span>
                02
                {settings.connections.length
                  ? ` · ${settings.connections.length} saved`
                  : ""}
              </span>
              <strong>Choose a model</strong>
              <small>
                {settings.default && defaultConnection
                  ? `Default: ${defaultConnection.label} / ${settings.default.modelId}`
                  : "Check a connection and set your shared default."}
              </small>
            </button>
            <a href="/settings/models">
              <span>03</span>
              <strong>Make it yours ↗</strong>
              <small>Choose a model for this browser.</small>
            </a>
          </nav>

          <div hidden={stage !== "connect"}>
            <p className="provider-stage-help">
              A provider is the service running your models. Connect a local
              Ollama service or a supported hosted provider. Saving a connection
              does not make a paid model request.
            </p>
            <AddProvider
              onSaved={(createdId) => {
                setPageNotice("");
                setActionError("");
                changed();
                setStage("choose");
                if (createdId) {
                  setEditing({ id: createdId, tab: "models" });
                }
              }}
            />
          </div>

          <section hidden={stage !== "choose"} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-[var(--color-text-3)]">
                  02 · Manage &amp; choose
                </p>
                <h2 className="mt-1 text-lg font-semibold">
                  Saved connections{" "}
                  <span className="ml-1 font-mono text-xs text-[var(--color-text-3)]">
                    {settings.connections.length}
                  </span>
                </h2>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setPageNotice("");
                  setActionError("");
                  setReload((value) => value + 1);
                }}
              >
                Refresh saved connections
              </Button>
            </div>

            {settings.connections.length > 0 && (
              <div className="provider-toolbar">
                <label className="models-search">
                  <SearchIcon size={15} aria-hidden="true" />
                  <span className="sr-only">Search connections</span>
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search connections or endpoints…"
                  />
                </label>

                <div
                  className="models-filters"
                  role="group"
                  aria-label="Filter connections"
                >
                  {(
                    [
                      ["all", "All"],
                      ["local", "Local"],
                      ["cloud", "Hosted"],
                      ["disabled", "Disabled"],
                    ] as const
                  ).map(([value, title]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                    >
                      {title}
                    </button>
                  ))}
                </div>

                <div
                  className="provider-view-toggle"
                  role="group"
                  aria-label="Layout view"
                >
                  <button
                    type="button"
                    aria-pressed={view === "grid"}
                    onClick={() => setView("grid")}
                  >
                    <LayoutGridIcon size={14} aria-hidden="true" />
                    Cards
                  </button>
                  <button
                    type="button"
                    aria-pressed={view === "table"}
                    onClick={() => setView("table")}
                  >
                    <TableIcon size={14} aria-hidden="true" />
                    Table
                  </button>
                </div>
              </div>
            )}

            {actionError && (
              <p
                role="alert"
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-error)]"
              >
                {actionError}
              </p>
            )}
            {pageNotice && (
              <p
                role="status"
                className="rounded-lg bg-[var(--color-surface-2)] p-3 text-sm"
              >
                {pageNotice}
              </p>
            )}
            {!settings.default && settings.connections.length > 0 && (
              <p className="rounded-lg bg-[var(--color-surface-2)] p-4 text-sm">
                Choose an instance default via <strong>Models</strong> on any
                enabled connection. Existing environment configuration and
                explicit device choices remain available during setup.
              </p>
            )}
            {!settings.connections.length && (
              <p className="rounded-xl border border-dashed border-[var(--color-border)] p-6 text-sm text-[var(--color-text-2)]">
                No saved connections yet. Start with a local service or find
                your hosted provider in Connect a provider.
              </p>
            )}
            {settings.connections.length > 0 && !visibleConnections.length && (
              <p
                role="status"
                className="rounded-xl border border-dashed border-[var(--color-border)] p-6 text-sm text-[var(--color-text-2)]"
              >
                No saved connections match your search or filter.
              </p>
            )}

            {visibleConnections.length > 0 && view === "grid" && (
              <div className="provider-connections-grid">
                {visibleConnections.map((connection) => (
                  <ProviderConnectionCard
                    key={connection.id}
                    connection={connection}
                    defaultModel={
                      settings.default?.connectionId === connection.id
                        ? settings.default.modelId
                        : null
                    }
                    busy={mutatingId === connection.id}
                    onEdit={(tab) => setEditing({ id: connection.id, tab })}
                    onToggleEnabled={() => {
                      void toggleEnabled(
                        connection.id,
                        connection.label,
                        connection.enabled,
                      );
                    }}
                    onRequestRemove={() => setRemovingId(connection.id)}
                  />
                ))}
              </div>
            )}

            {visibleConnections.length > 0 && view === "table" && (
              <div className="provider-table-wrap">
                <table className="provider-table">
                  <thead>
                    <tr>
                      <th scope="col">Provider</th>
                      <th scope="col">Type</th>
                      <th scope="col">Endpoint</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="text-right">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleConnections.map((connection) => (
                      <ProviderConnectionTableRow
                        key={connection.id}
                        connection={connection}
                        defaultModel={
                          settings.default?.connectionId === connection.id
                            ? settings.default.modelId
                            : null
                        }
                        busy={mutatingId === connection.id}
                        onEdit={(tab) => setEditing({ id: connection.id, tab })}
                        onToggleEnabled={() => {
                          void toggleEnabled(
                            connection.id,
                            connection.label,
                            connection.enabled,
                          );
                        }}
                        onRequestRemove={() => setRemovingId(connection.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p
            hidden={stage !== "choose"}
            className="text-xs leading-relaxed text-[var(--color-text-3)]"
          >
            Default and endpoint changes apply to new requests. Existing queued
            work keeps its original provider version and model.
          </p>

          {!!settings.environment.length && (
            <details
              hidden={stage !== "connect"}
              className="provider-import space-y-4"
            >
              <summary>Advanced · Import existing server configuration</summary>
              <p className="text-sm text-[var(--color-text-2)]">
                Import a connection to manage its token and enabled state here.
                Wrenly copies credentials server-side and never displays them or
                rewrites your environment file. Finish requests using the old
                provider first; old device or queued selections must be
                refreshed after import. Choose a saved default afterward.
              </p>
              {settings.environment.map((provider) => (
                <ImportEnvironmentProvider
                  key={`${provider.id}:${provider.reviewVersion}`}
                  provider={provider}
                  imported={settings.connections.some(
                    (connection) => connection.envSourceId === provider.id,
                  )}
                  onChanged={() => {
                    setPageNotice("");
                    changed();
                  }}
                />
              ))}
            </details>
          )}

          <ProviderConnectionDialog
            connection={editingConnection}
            defaultModel={
              editingConnection &&
              settings.default?.connectionId === editingConnection.id
                ? settings.default.modelId
                : null
            }
            initialTab={editing?.tab ?? "general"}
            open={Boolean(editingConnection)}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) setEditing(null);
            }}
            onChanged={() => {
              setPageNotice("");
              changed();
            }}
          />

          <ProviderRemoveDialog
            connection={removingConnection}
            defaultModel={
              removingConnection &&
              settings.default?.connectionId === removingConnection.id
                ? settings.default.modelId
                : null
            }
            open={Boolean(removingConnection)}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) setRemovingId(null);
            }}
            onRemoved={(result, removedLabel) => {
              if (editing?.id === removingConnection?.id) setEditing(null);
              setRemovingId(null);
              setPageNotice(
                result.clearedInstanceDefault
                  ? `Removed ${removedLabel}. The instance default was cleared — choose another default model for new requests.`
                  : `Removed ${removedLabel}.`,
              );
              changed();
            }}
          />
        </>
      )}
    </main>
  );
}
