"use client";
// Separates this browser's model preference from the server-managed instance default.
// Device preferences stay separate from owner-managed shared connections/defaults.

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useSetupSummary } from "@/lib/onboarding/setup-summary";
import {
  clearModelSelection,
  resolveSelection,
  setModelSelection,
  useModels,
} from "@/lib/models/discovery";
import type { ModelSelection } from "@/lib/models/discovery";
import {
  CheckIcon,
  RefreshCwIcon,
  SearchIcon,
  CpuIcon,
  GlobeIcon,
  ArrowUpRightIcon,
} from "lucide-react";

/** Empty state — the first-run path when nothing is reachable yet. */
function EmptyModelState(): React.JSX.Element {
  return (
    <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-6 py-8 text-center">
      <p className="text-sm font-medium text-[var(--color-text-1)]">
        No models discovered
      </p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-[var(--color-text-2)]">
        Start your local model service (or ask the instance owner to add a
        hosted provider) and Wrenly will list its models here automatically.
      </p>
      <pre className="mx-auto mt-4 w-fit rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-3 py-2 text-left font-mono text-[11px] whitespace-pre-wrap text-[var(--color-text-1)]">
        {`ollama serve
ollama pull <model-name>`}
      </pre>
    </div>
  );
}

export default function ModelPreferencesPage(): React.JSX.Element {
  const { data, isPending, isError, refetch, isFetching } = useModels();
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "local" | "cloud">("all");
  const summary = useSetupSummary();
  const canManageAccess = summary.data?.role === "owner" && !summary.isError;
  const [hasLegacyProjects, setHasLegacyProjects] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const check = async (): Promise<void> => {
      try {
        const response = await apiFetch("/api/instance/legacy-projects", {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10_000),
          ]),
        });
        if (!response.ok) return;
        const value: unknown = await response.json();
        if (
          !controller.signal.aborted &&
          value &&
          typeof value === "object" &&
          "projects" in value &&
          Array.isArray(value.projects)
        )
          setHasLegacyProjects(value.projects.length > 0);
      } catch {
        /* Optional recovery notice; the dedicated screen handles failures. */
      }
    };
    if (canManageAccess) void check();
    return () => controller.abort();
  }, [canManageAccess]);

  // Refresh derived defaults while preserving explicit device choices.
  useEffect(() => {
    if (!data) return;
    try { setSelection(resolveSelection(data)); setPreferenceError(null); }
    catch (error) { setSelection(null); setPreferenceError(error instanceof Error ? error.message : "Model preference unavailable."); }
  }, [data]);

  const choose = (next: ModelSelection): void => {
    try { setModelSelection(next); setSelection(next); setPreferenceError(null); }
    catch (error) { setPreferenceError(error instanceof Error ? error.message : "Model preference unavailable."); }
  };

  const selectedModel = data?.models.find(
    (model) =>
      model.id === selection?.model && model.provider === selection.provider,
  );
  const defaultSelection = data ? resolveSelection(data, null) : null;
  const defaultModel = data?.models.find(
    (model) =>
      model.id === defaultSelection?.model &&
      model.provider === defaultSelection.provider,
  );
  const query = search.trim().toLocaleLowerCase();
  const visibleModels =
    data?.models.filter((model) => {
      const provider = data.providers.find(
        (item) => item.id === model.provider,
      );
      return (
        (kind === "all" || model.kind === kind) &&
        `${model.label} ${model.id} ${provider?.label ?? model.provider}`
          .toLocaleLowerCase()
          .includes(query)
      );
    }) ?? [];
  const resetSelection = (): void => {
    try { clearModelSelection(); setSelection(resolveSelection(data, null)); setPreferenceError(null); }
    catch (error) { setPreferenceError(error instanceof Error ? error.message : "Model preference unavailable."); }
  };

  return (
    <div className="mx-auto max-w-3xl px-8 py-16 models-preferences">
      {preferenceError && <p role="alert" className="mb-4 text-sm">{preferenceError}</p>}
      <p className="settings-eyebrow">Your settings / Models</p>
      <div className="models-heading">
        <div>
          <h1>Models.</h1>
          <p>
            Choose the model for your next conversation. Local or hosted, on your terms.
          </p>
        </div>
        {canManageAccess && (
          <a href="/settings/providers">
            {data?.providers.length ? "Add provider" : "Add your first provider"} <ArrowUpRightIcon size={14} aria-hidden="true" />
          </a>
        )}
      </div>
      {canManageAccess && hasLegacyProjects && (
        <div className="mb-8 rounded border border-[var(--color-border)] p-4 text-sm">
          <p>
            Projects from the former local identity are available for recovery.
          </p>
          <a
            href="/settings/legacy-projects"
            className="mt-2 inline-block underline"
          >
            Review legacy projects
          </a>
        </div>
      )}

      <div className="models-summary" aria-label="Model preferences">
        <section><span>This browser</span><strong>{selectedModel?.label ?? (isPending ? "Loading…" : !data?.models.length ? "No models configured" : selection?.model ?? "No model selected")}</strong>
          <small>{selection && !selectedModel && data ? "Saved choice · not in the latest list" : "Used for new private conversations"}</small></section>
        <section><span>Instance default</span><strong>{defaultModel?.label ?? (isPending ? "Loading…" : "Not configured")}</strong>
          <button type="button" onClick={resetSelection} disabled={!data}>Use instance default <ArrowUpRightIcon size={13} aria-hidden="true" /></button></section>
      </div>
      <p className="models-scope-note">Shared projects keep their owner-selected model. This choice stays in your browser.</p>
      <div className="models-provider-overview">
        <div className="mb-4 flex items-baseline justify-between border-b border-[var(--color-border)] pb-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-3)]">
            Connected providers
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-text-2)] transition-colors hover:text-[var(--color-text-1)] disabled:opacity-60"
          >
            <RefreshCwIcon
              className={`size-3 ${isFetching ? "animate-spin" : ""}`}
            />
            re-scan
          </button>
        </div>

        <div className="provider-inspector">
          {isPending && <p role="status">Loading providers…</p>}
          {data && !data.providers.length && <p>No provider connections yet.</p>}
          {Boolean(data?.providers.length) && <div className="provider-marquee" aria-hidden="true" data-animated={(data?.providers.length ?? 0) > 1}>
            <div className="provider-marquee-track">{[0, 1].map(copy => <div className="provider-marquee-group" key={copy}>
              {data?.providers.map(provider => <span className="provider-marquee-item" key={provider.id}>
                {provider.kind === "local" ? <CpuIcon size={17} /> : <GlobeIcon size={17} />}<span>{provider.label}</span>
              </span>)}
            </div>)}</div>
          </div>}
        </div>

      </div>
      <div className="models-inventory-heading">
        <h2>
          Available models <span>{data?.models.length ?? "—"}</span>
        </h2>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCwIcon
            size={13}
            className={isFetching ? "animate-spin" : ""}
            aria-hidden="true"
          />{" "}
          Refresh
        </button>
      </div>
      <div className="models-toolbar">
        <label className="models-search">
          <SearchIcon size={15} aria-hidden="true" />
          <span className="sr-only">Search models</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models or providers…"
          />
        </label>
        <div
          className="models-filters"
          role="group"
          aria-label="Model location"
        >
          {(["all", "local", "cloud"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
            >
              {value === "all"
                ? "All models"
                : value === "local"
                  ? "Local"
                  : "Cloud"}
            </button>
          ))}
        </div>
      </div>
      {isPending && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-11 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-2)]"
            />
          ))}
        </div>
      )}

      {isError && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 text-sm text-[var(--color-text-2)]">
          Could not reach the model discovery endpoint.
          <button
            type="button"
            onClick={() => void refetch()}
            className="ml-2 text-[var(--color-accent)] hover:underline"
          >
            Try again
          </button>
        </div>
      )}

      {data && data.models.length === 0 && !isPending && <EmptyModelState />}

      {data && data.models.length > 0 && visibleModels.length === 0 && (
        <p className="models-no-results" role="status">
          No models match your search. Try another name or location.
        </p>
      )}
      {visibleModels.length > 0 && (
        <div
          className="models-choice-list"
          aria-label="Available model choices"
        >
          {visibleModels.map((option) => {
            const provider = data?.providers.find(
              (item) => item.id === option.provider,
            );
            const isSelected =
              selection?.model === option.id &&
              selection.provider === option.provider;
            return (
              <button
                key={`${option.provider}:${option.id}`}
                type="button"
                className="models-choice models-choice-row"
                aria-pressed={isSelected}
                onClick={() =>
                  choose({ model: option.id, provider: option.provider })
                }
              >
                <span className="models-choice-provider">
                  {option.kind === "local" ? (
                    <CpuIcon size={15} aria-hidden="true" />
                  ) : (
                    <GlobeIcon size={15} aria-hidden="true" />
                  )}
                  {provider?.label ?? option.provider}
                </span>
                <strong>{option.label}</strong>
                <span className="models-choice-id">{option.id}</span>
                <span className="models-choice-footer">
                  <span>{option.kind === "local" ? "Local" : "Cloud"}</span>
                  <span className="models-choice-check">{isSelected && <CheckIcon size={13} aria-hidden="true" />}<span className="sr-only">{isSelected ? "Selected" : "Use model"}</span></span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
