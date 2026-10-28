"use client";
// Coordinates owner-reviewed connection setup while server endpoints enforce credential access.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ImportEnvironmentProvider } from "@/components/settings/providers/import-environment-provider";
import { AddProvider } from "@/components/settings/providers/add-provider";
import { ProviderConnectionCard } from "@/components/settings/providers/provider-connection";
import {
  parseProviderSettings,
  providerSettingsRequest,
  ProviderSettingsError,
  type ProviderSettings,
} from "@/lib/models/provider-settings";
export default function ProviderSettingsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const initialized = useRef(false);
  const [stage, setStage] = useState<"connect" | "choose">("connect");
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
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
          if (!initialized.current) {
            setStage(value.connections.length ? "choose" : "connect");
            initialized.current = true;
          }
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
  return (
    <main className="mx-auto w-full max-w-4xl space-y-8 px-5 py-10 sm:px-8 sm:py-14">
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
              <span>02</span>
              <strong>Choose a model</strong>
              <small>Check a connection and set your shared default.</small>
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
              onSaved={() => {
                changed();
                setStage("choose");
              }}
            />
          </div>
          <section hidden={stage !== "choose"} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-[var(--color-text-3)]">
                  02 · Check &amp; choose
                </p>
                <h2 className="mt-1 text-lg font-semibold">
                  Saved connections
                </h2>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setReload((value) => value + 1)}
              >
                Refresh saved connections
              </Button>
            </div>
            {!settings.default && (
              <p className="rounded-lg bg-[var(--color-surface-2)] p-4 text-sm">
                Choose an instance default below. Existing environment
                configuration and explicit device choices remain available
                during setup.
              </p>
            )}
            {!settings.connections.length && (
              <p className="rounded-xl border border-dashed border-[var(--color-border)] p-6 text-sm text-[var(--color-text-2)]">
                No saved connections yet. Start with a local service or find
                your hosted provider in Connect a provider.
              </p>
            )}
            {settings.connections.map((connection) => (
              <ProviderConnectionCard
                key={connection.id}
                connection={connection}
                defaultModel={
                  settings.default?.connectionId === connection.id
                    ? settings.default.modelId
                    : null
                }
                onChanged={changed}
              />
            ))}
          </section>
          <p
            hidden={stage !== "choose"}
            className="text-xs leading-relaxed text-[var(--color-text-3)]"
          >
            Default changes apply to new requests. Existing queued work keeps
            its original provider and model.
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
                  onChanged={changed}
                />
              ))}
            </details>
          )}
        </>
      )}
    </main>
  );
}
