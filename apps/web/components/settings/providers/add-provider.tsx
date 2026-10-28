"use client";
// Reviews a destination and saves one provider connection with a stable retry identity.
import { useEffect, useRef, useState } from "react";
import { HardDriveIcon, CloudIcon, SlidersHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  parseCatalogResult,
  providerSettingsRequest,
  type CatalogEntry,
  type CatalogResult,
} from "@/lib/models/provider-settings";
type Source = "ollama" | "catalog" | "custom";
const SEARCH_DELAY_MS = 300;
const PAGE_SIZE = 20;
/** Guides explicit provider creation without persisting credentials in the browser. */
export function AddProvider({
  onSaved,
}: {
  onSaved: () => void;
}): React.JSX.Element {
  const [source, setSource] = useState<Source>("ollama");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [selected, setSelected] = useState<{
    provider: CatalogEntry;
    version: string;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [catalogReload, setCatalogReload] = useState(0);
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState("http://localhost:11434");
  const [kind, setKind] = useState<"local" | "cloud">("cloud");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(false);
  const requestId = useRef<string | null>(null);
  const resetRequest = (): void => {
    requestId.current = null;
    setError("");
    setNotice("");
    setSaved(false);
  };
  useEffect(() => {
    if (source !== "catalog") return;
    const controller = new AbortController();
    setSearching(true);
    setCatalogError("");
    const timer = setTimeout(() => {
      const load = async (): Promise<void> => {
        try {
          const result = parseCatalogResult(
            await providerSettingsRequest(
              `/api/models/catalog?q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}&offset=${offset}`,
              "GET",
              undefined,
              controller.signal,
            ),
          );
          if (!controller.signal.aborted) setCatalog(result);
        } catch (failure) {
          if (!controller.signal.aborted) {
            setCatalog(null);
            setCatalogError(
              failure instanceof Error
                ? failure.message
                : "The catalog is unavailable.",
            );
          }
        } finally {
          if (!controller.signal.aborted) setSearching(false);
        }
      };
      void load();
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source, query, offset, catalogReload]);
  const changeSource = (next: Source): void => {
    setSource(next);
    setSelected(null);
    setToken("");
    setLabel("");
    setEndpoint(next === "ollama" ? "http://localhost:11434" : "");
    resetRequest();
  };
  const refreshCatalog = async (): Promise<void> => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await providerSettingsRequest("/api/models/catalog/refresh", "POST");
      setSelected(null);
      requestId.current = null;
      setCatalogReload((value) => value + 1);
      setNotice(
        "Catalog updated. Select a provider to review its current destination.",
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Catalog refresh failed. The saved catalog is still available.",
      );
    } finally {
      setBusy(false);
    }
  };
  const save = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      requestId.current ??= crypto.randomUUID();
      const common = { requestId: requestId.current };
      const body =
        source === "catalog"
          ? {
              ...common,
              source,
              providerId: selected?.provider.id,
              catalogVersion: selected?.version,
              token,
              ...(label.trim() ? { label } : {}),
            }
          : source === "ollama"
            ? {
                ...common,
                source,
                endpoint,
                label: label.trim() || "Ollama",
                ...(token ? { token } : {}),
              }
            : {
                ...common,
                source,
                endpoint,
                label,
                kind,
                ...(token ? { token } : {}),
              };
      await providerSettingsRequest("/api/models/connections", "POST", body);
      setToken("");
      requestId.current = null;
      setSaved(true);
      setNotice(
        "Connection saved. Check it below, then choose an instance default.",
      );
      onSaved();
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : "Connection could not be saved."} If the response was lost, refresh saved connections or retry without changing these settings.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const compatible =
    selected?.provider.compatibility === "openai-compatible" &&
    Boolean(selected.provider.endpoint);
  return (
    <section className="space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6">
      <div>
        <p className="text-xs text-[var(--color-text-3)]">01 · Connect</p>
        <h2 className="mt-1 text-lg font-semibold">Add a model provider</h2>
        <p className="mt-1 text-sm text-[var(--color-text-2)]">
          Use a local model service or connect a hosted provider. Saving does
          not start generation.
        </p>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Connection type">
        {(
          [
            ["ollama", "Local · Ollama"],
            ["catalog", "Hosted provider"],
            ["custom", "Custom endpoint"],
          ] as const
        ).map(([value, title]) => (
          <Button
            key={value}
            className="provider-source-choice"
            aria-label={title}
            variant={source === value ? "default" : "outline"}
            disabled={busy}
            aria-pressed={source === value}
            onClick={() => changeSource(value)}
          >
            {value === "ollama" ? (
              <HardDriveIcon size={20} aria-hidden="true" />
            ) : value === "catalog" ? (
              <CloudIcon size={20} aria-hidden="true" />
            ) : (
              <SlidersHorizontalIcon size={20} aria-hidden="true" />
            )}
            <span>{title}</span>
            <small>
              {value === "ollama"
                ? "Models on your server"
                : value === "catalog"
                  ? "Find a hosted service"
                  : "Use a compatible gateway"}
            </small>
          </Button>
        ))}
      </div>
      {source === "catalog" && (
        <div className="space-y-3">
          <label className="block space-y-2 text-sm">
            <span>Find a provider or model</span>
            <Input
              value={query}
              maxLength={200}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
              placeholder="Search the public catalog"
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-2)]">
            <span>
              {catalog
                ? `${catalog.totalProviders} providers · ${catalog.origin}${catalog.stale ? " · older snapshot" : ""}`
                : "The bundled catalog works offline."}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || searching}
              onClick={() => {
                void refreshCatalog();
              }}
            >
              Update public catalog
            </Button>
          </div>
          {searching && (
            <p role="status" className="text-sm">
              Searching catalog…
            </p>
          )}
          {catalogError && (
            <p role="alert" className="text-sm">
              {catalogError} Local and custom setup are still available.
            </p>
          )}
          {!searching && catalog && (
            <>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)]">
                {catalog.providers.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    disabled={busy}
                    aria-pressed={selected?.provider.id === provider.id}
                    onClick={() => {
                      setSelected({ provider, version: catalog.version });
                      setToken("");
                      setLabel("");
                      resetRequest();
                    }}
                    className={`flex w-full items-start justify-between gap-3 border-b border-[var(--color-border)] p-3 text-left last:border-0 hover:bg-[var(--color-surface-2)] ${selected?.provider.id === provider.id ? "bg-[var(--color-surface-2)]" : ""}`}
                  >
                    <span className="text-sm font-medium">
                      {provider.name}
                      <span className="mt-1 block text-xs font-normal text-[var(--color-text-3)]">
                        {provider.modelCount} catalog models
                      </span>
                    </span>
                    <span className="text-xs text-[var(--color-text-2)]">
                      {provider.compatibility === "openai-compatible"
                        ? "Compatible API"
                        : provider.compatibility === "adapter-required"
                          ? "Adapter required"
                          : "Endpoint required"}
                    </span>
                  </button>
                ))}
                {!catalog.providers.length && (
                  <p className="p-4 text-sm">
                    No catalog matches. Try another name or use a custom
                    compatible endpoint.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || offset === 0}
                  onClick={() =>
                    setOffset((value) => Math.max(0, value - PAGE_SIZE))
                  }
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    busy || offset + PAGE_SIZE >= catalog.totalProviders
                  }
                  onClick={() => setOffset((value) => value + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </>
          )}
          {selected && (
            <div className="space-y-2 rounded-lg bg-[var(--color-surface-2)] p-4 text-sm">
              <p className="font-medium">{selected.provider.name}</p>
              {compatible ? (
                <>
                  <p>Credentials will be sent to:</p>
                  <p className="break-all font-mono text-xs">
                    {selected.provider.endpoint}
                  </p>
                </>
              ) : (
                <p>
                  This catalog entry needs{" "}
                  {selected.provider.compatibility === "adapter-required"
                    ? "a protocol adapter that Wrenly has not enabled yet"
                    : "an explicit API endpoint"}
                  . Choose a supported provider, or configure a compatible
                  gateway under Custom endpoint.
                </p>
              )}
              {selected.provider.documentationUrl && (
                <a
                  href={selected.provider.documentationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block underline"
                >
                  Provider documentation
                </a>
              )}
            </div>
          )}
        </div>
      )}
      {(source !== "catalog" || compatible) && (
        <form
          onSubmit={(event) => {
            void save(event);
          }}
          className="space-y-4"
        >
          {source === "ollama" && (
            <div className="space-y-2 text-sm text-[var(--color-text-2)]">
              <p>
                Wrenly checks the server running its API, which may be different
                from this computer. Use the address of your Ollama service;
                container localhost points to that container.
              </p>
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Install Ollama
              </a>
              <p>
                Start it with <code>ollama serve</code>. Install a model suited
                to your hardware with{" "}
                <code>ollama pull &lt;model-name&gt;</code>, then check the
                connection below.
              </p>
            </div>
          )}
          <label className="block space-y-2 text-sm">
            <span>Connection name {source !== "custom" && "(optional)"}</span>
            <Input
              value={label}
              required={source === "custom"}
              maxLength={100}
              disabled={busy}
              onChange={(event) => {
                setLabel(event.target.value);
                resetRequest();
              }}
              placeholder={
                source === "ollama"
                  ? "Ollama"
                  : (selected?.provider.name ?? "My model service")
              }
            />
          </label>
          {source !== "catalog" && (
            <label className="block space-y-2 text-sm">
              <span>
                {source === "ollama"
                  ? "Ollama server address"
                  : "OpenAI-compatible API base URL"}
              </span>
              <Input
                type="url"
                required
                maxLength={2048}
                value={endpoint}
                disabled={busy}
                onChange={(event) => {
                  setEndpoint(event.target.value);
                  resetRequest();
                }}
                placeholder={
                  source === "ollama"
                    ? "http://localhost:11434"
                    : "https://your-provider.example/v1"
                }
              />
            </label>
          )}
          {source === "custom" && (
            <label className="block space-y-2 text-sm">
              <span>Where is this service?</span>
              <select
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
                value={kind}
                disabled={busy}
                onChange={(event) => {
                  setKind(event.target.value as "local" | "cloud");
                  resetRequest();
                }}
              >
                <option value="cloud">Hosted · public HTTPS address</option>
                <option value="local">
                  Local · this server or a private network
                </option>
              </select>
            </label>
          )}
          <label className="block space-y-2 text-sm">
            <span>API token {source !== "catalog" && "(if required)"}</span>
            <Input
              type="password"
              autoComplete="new-password"
              value={token}
              maxLength={8192}
              disabled={busy}
              required={source === "catalog"}
              onChange={(event) => {
                setToken(event.target.value);
                resetRequest();
              }}
            />
            <span className="block text-xs text-[var(--color-text-3)]">
              Encrypted on this Wrenly instance. Saved tokens are never
              displayed again. Members use this connection&apos;s quota.
            </span>
          </label>
          <Button type="submit" disabled={busy || saved}>
            {saved ? "Connection saved" : busy ? "Saving…" : "Save connection"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
