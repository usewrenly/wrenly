"use client";
// Checks never start inference; catalog/manual IDs remain distinct from served models.
import { useState } from "react";
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
/** Manages one immutable destination and its model selection without reading its saved token. */
export function ProviderConnectionCard({
  connection,
  defaultModel,
  onChanged,
}: {
  connection: ProviderConnection;
  defaultModel: string | null;
  onChanged: () => void;
}): React.JSX.Element {
  const [probe, setProbe] = useState<ConnectionProbe | null>(null);
  const [model, setModel] = useState(defaultModel ?? "");
  const [token, setToken] = useState("");
  const [catalogModels, setCatalogModels] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
        "Instance default saved. New requests use it unless a device or composer choice overrides it.",
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
        `${result.totalModels} catalog matches. These are metadata, not proof of access for your token. Narrow the search if the model is not in the first 40 results.`,
      );
    });
  };
  return (
    <article className="provider-saved-card space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{connection.label}</h3>
          <p className="mt-1 text-xs text-[var(--color-text-3)]">
            {connection.kind === "local" ? "Local service" : "Hosted service"} ·{" "}
            {connection.enabled ? "Enabled" : "Disabled"} ·{" "}
            {connection.tokenConfigured ? "Token saved" : "No token saved"}
          </p>
        </div>
        {defaultModel && (
          <span className="rounded-full border border-[var(--color-border)] px-2 py-1 text-xs">
            Instance default
          </span>
        )}
      </div>
      <p className="break-all font-mono text-xs text-[var(--color-text-2)]">
        {connection.endpoint}
      </p>
      {defaultModel && (
        <p className="text-sm">
          Default model: <code className="break-all">{defaultModel}</code>
          {!connection.enabled &&
            " · disabled; requests cannot use this default until you enable it or choose another connection."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || !connection.enabled}
          onClick={() => {
            void check();
          }}
        >
          Check connection
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            void run(async () => {
              await providerSettingsRequest(
                "/api/models/connections",
                "PATCH",
                { id: connection.id, enabled: !connection.enabled },
              );
              setProbe(null);
              setNotice(
                connection.enabled
                  ? "Connection disabled. Queued work cannot switch to another provider."
                  : "Connection enabled.",
              );
              onChanged();
            });
          }}
        >
          {connection.enabled ? "Disable" : "Enable"}
        </Button>
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
                  {connection.protocol === "ollama" ? "local" : "served"} model
                </span>
                <ChoiceSelect
                  label={
                    connection.protocol === "ollama"
                      ? "Choose a local model"
                      : "Choose a served model"
                  }
                  value={probe.models.includes(model) ? model : null}
                  disabled={busy}
                  onChange={setModel}
                  displayValue={
                    probe.models.includes(model) ? model : "Select a model"
                  }
                  options={probe.models.map((id) => ({ value: id, label: id }))}
                />
              </label>
            </>
          )}
        </div>
      )}
      {connection.enabled && (
        <div className="space-y-4 border-t border-[var(--color-border)] pt-4">
          {connection.catalogProviderId && (
            <form onSubmit={searchModels} className="space-y-2">
              <label className="block space-y-2 text-sm">
                <span>Search this provider&apos;s catalog models</span>
                <Input
                  value={catalogQuery}
                  maxLength={200}
                  disabled={busy}
                  onChange={(event) => setCatalogQuery(event.target.value)}
                  placeholder="Model name or ID"
                />
              </label>
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                Search catalog models
              </Button>
              {!!catalogModels.length && (
                <label className="block space-y-2 text-sm">
                  <span>Catalog choices · access not verified</span>
                  <ChoiceSelect
                    label="Catalog choices · access not verified"
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
              Use the exact ID from this service. A manual or catalog ID is not
              live-verified; model access is checked when you send a request.
            </p>
            <Button type="submit" disabled={busy || !model.trim()}>
              Set instance default
            </Button>
          </form>
        </div>
      )}
      <details className="rounded-lg border border-[var(--color-border)] p-3">
        <summary className="cursor-pointer text-sm">Replace API token</summary>
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await providerSettingsRequest(
                "/api/models/connections",
                "PATCH",
                { id: connection.id, token },
              );
              setToken("");
              setProbe(null);
              setNotice("Token replaced. Check the connection again.");
              onChanged();
            });
          }}
        >
          <label className="block space-y-2 text-sm">
            <span>New token</span>
            <Input
              type="password"
              autoComplete="new-password"
              value={token}
              maxLength={8192}
              disabled={busy}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <p className="text-xs text-[var(--color-text-3)]">
            The saved token is never shown. Leaving this blank keeps it
            unchanged. The destination stays fixed; add a new connection to
            change its address.
          </p>
          <Button
            type="submit"
            variant="outline"
            disabled={busy || !token.trim()}
          >
            Replace token
          </Button>
        </form>
      </details>
      {busy && (
        <p role="status" className="text-sm">
          Updating connection…
        </p>
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
    </article>
  );
}
