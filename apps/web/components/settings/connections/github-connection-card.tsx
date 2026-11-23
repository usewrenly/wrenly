"use client";
/** Browser account setup uses server-issued redirects; credentials stay in the API. */
import styles from "./connections.module.css";
import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
import { ArrowUpRightIcon } from "lucide-react";
import {
  IMPORT_LIMIT_PRESETS,
  parseSourceConnectionStatus,
  type ImportLimitPresetId,
} from "@wrenly/source-control";
import { authClient } from "@/lib/auth/auth-client";
import { apiFetch } from "@/lib/api";
import { readSourceResponse as result } from "@/lib/source-control/response";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DocumentationLink } from "@/components/documentation-link";
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const IMPORT_LIMIT_OPTIONS: Array<{
  id: ImportLimitPresetId;
  title: string;
  badge: string;
  summary: string;
  description: string;
}> = [
  {
    id: "default",
    title: "Standard",
    badge: "Default",
    summary: "8 MB text · 12 MB assets · 1,000 files",
    description:
      "Fast repository review with compact revision storage for typical web apps.",
  },
  {
    id: "medium",
    title: "Expanded",
    badge: "32 MB",
    summary: "32 MB text · 32 MB assets · 4,000 files",
    description:
      "Fits multi-module Next.js and Laravel apps with moderate media assets.",
  },
  {
    id: "large",
    title: "Large",
    badge: "128 MB",
    summary: "128 MB text · 128 MB assets · 16,000 files",
    description:
      "Supports monorepos and asset-rich projects on hosts with ample RAM and disk.",
  },
  {
    id: "unlimited",
    title: "Unlimited",
    badge: "Uncapped",
    summary: "Up to 1 GB · 100,000 files",
    description:
      "Removes everyday source caps using your self-hosted database and build disk.",
  },
];

function formatLimitBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}
/** Account-scoped query keys avoid showing a former signed-in user's connection after switching accounts. */
export function GitHubConnectionCard(): React.JSX.Element {
  const { data: session } = authClient.useSession();
  return (
    <PersonalGitHubConnection
      key={session?.user.id ?? "signed-out"}
      userId={session?.user.id}
    />
  );
}
function PersonalGitHubConnection({
  userId,
}: {
  userId: string | undefined;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useSearchParams();
  const outcome = query.get("github");
  const [allowOtherAccounts, setAllowOtherAccounts] = useState(false);
  const [name, setName] = useState("Wrenly studio");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const status = useQuery({
    queryKey: ["source-github", userId],
    enabled: Boolean(userId),
    retry: false,
    queryFn: async () =>
      parseSourceConnectionStatus(
        await result(
          await apiFetch("/api/source/github", {
            signal: AbortSignal.timeout(15000),
          }),
        ),
      ),
  });
  const [repositories, setRepositories] = useState<string[] | null>(null);
  const [selectedPreset, setSelectedPreset] =
    useState<ImportLimitPresetId | null>(null);
  const [limitsMessage, setLimitsMessage] = useState<string | null>(null);
  async function act(run: () => Promise<void>): Promise<void> {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Connection request failed. Reload its status before trying again.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function begin(action: "register" | "connect"): Promise<void> {
    await act(async () => {
      const value = await result(
        await apiFetch("/api/source/github/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify(
            action === "register"
              ? { action, name, allowOtherAccounts }
              : { action },
          ),
        }),
      );
      if (!record(value) || typeof value.url !== "string")
        throw new Error("GitHub setup response could not be read.");
      const url = new URL(value.url);
      if (url.origin !== "https://github.com" || url.username || url.password)
        throw new Error("GitHub setup address could not be verified.");
      if (
        value.kind === "registration" &&
        url.pathname === "/settings/apps/new" &&
        record(value.manifest)
      ) {
        if (
          typeof value.manifest.url !== "string" ||
          !record(value.manifest.hook_attributes) ||
          typeof value.manifest.hook_attributes.url !== "string" ||
          value.manifest.hook_attributes.active !== false
        )
          throw new Error(
            "GitHub registration settings are incomplete. Reload Connections and try again.",
          );
        const form = document.createElement("form"),
          input = document.createElement("input");
        form.method = "POST";
        form.enctype = "application/x-www-form-urlencoded";
        form.action = url.href;
        input.type = "hidden";
        input.name = "manifest";
        input.value = JSON.stringify(value.manifest);
        form.append(input);
        document.body.append(form);
        form.submit();
        // Keep the submitted form attached until navigation has consumed its fields.
      } else if (
        value.kind === "authorization" &&
        url.pathname === "/login/oauth/authorize"
      )
        window.location.assign(url.href);
      else throw new Error("GitHub setup action could not be verified.");
    });
  }
  async function disconnect(): Promise<void> {
    await act(async () => {
      if (!status.data?.connection) return;
      await result(
        await apiFetch("/api/source/github/disconnect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ version: status.data.connection.version }),
        }),
      );
      setRepositories(null);
      queryClient.removeQueries({
        queryKey: ["source-github-repositories", userId],
      });
      await status.refetch();
    });
  }
  async function checkRepositories(): Promise<void> {
    await act(async () => {
      const value = await result(
        await apiFetch("/api/source/github/repositories", {
          signal: AbortSignal.timeout(35000),
        }),
      );
      if (
        !record(value) ||
        !Array.isArray(value.repositories) ||
        value.repositories.length > 200
      )
        throw new Error("Repository access could not be read.");
      const names = value.repositories.map((item: unknown) => {
        if (
          !record(item) ||
          typeof item.owner !== "string" ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(item.owner) ||
          typeof item.name !== "string" ||
          !/^[A-Za-z0-9_.-]{1,100}$/.test(item.name)
        )
          throw new Error("Repository access could not be read.");
        return `${item.owner}/${item.name}`;
      });
      setRepositories(names);
    });
  }
  async function updateImportLimits(
    payload: { preset?: ImportLimitPresetId; reset?: boolean },
    successText: string,
  ): Promise<void> {
    setLimitsMessage(null);
    await act(async () => {
      await result(
        await apiFetch("/api/source/github/limits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify(payload),
        }),
      );
      setSelectedPreset(null);
      setLimitsMessage(successText);
      await status.refetch();
    });
  }
  const current = status.data;
  const activePreset = current?.importLimits?.preset ?? "default";
  const effectivePreset = selectedPreset ?? activePreset;
  const selectedOptionIndex = Math.max(
    0,
    IMPORT_LIMIT_OPTIONS.findIndex((item) => item.id === effectivePreset),
  );
  const selectedOption =
    IMPORT_LIMIT_OPTIONS[selectedOptionIndex] ?? IMPORT_LIMIT_OPTIONS[0]!;
  const previewLimits =
    selectedPreset && selectedPreset !== activePreset
      ? IMPORT_LIMIT_PRESETS[selectedOption.id].limits
      : (current?.importLimits?.limits ??
        IMPORT_LIMIT_PRESETS[selectedOption.id].limits);
  const canManageLimits =
    current?.importLimits?.canManage ?? current?.canRegister ?? false;
  return (
    <article className={`connection-card ${styles.github}`}>
      <Image src="/connectors/github.svg" alt="" width={24} height={24} />
      <div className={styles.body}>
        <div className={styles.githubHeader}>
          <h2>GitHub</h2>
          {status.isPending ? (
            <span className="connection-state">Checking connection…</span>
          ) : current?.connection ? (
            <span className={styles.badgeActive}>
              <span className={styles.dotActive} aria-hidden="true" />
              Connected · {current.connection.login}
            </span>
          ) : current?.app ? (
            <span className={styles.badgeAvailable}>
              Ready to connect account
            </span>
          ) : (
            <span className={styles.badgeWarning}>Not registered</span>
          )}
        </div>
        <p>
          {current?.connection
            ? "Your source, connected. Choose repository access here, then import from Home or connect a project in its workspace."
            : "Connect your own GitHub account to import apps and push reviewed changes. Each member controls their own repository access."}
        </p>
        {outcome === "registered" ? (
          <p role="status">
            GitHub App registered. Now connect your account and choose
            repository access.
          </p>
        ) : null}
        {outcome === "failed" ? (
          <p role="alert">
            GitHub setup did not complete. Check the connection below before
            starting again.
          </p>
        ) : null}
        {status.isError ? (
          <div role="alert">
            <p>
              Connection status is unavailable. Apply the latest database
              migrations if this instance was just updated.
            </p>
            <Button variant="outline" onClick={() => void status.refetch()}>
              Reload connection
            </Button>
          </div>
        ) : null}
        {current && !current.app ? (
          current.canRegister ? (
            <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
              <h3 className="font-medium">01 · Register this instance</h3>
              <p className="text-sm text-muted-foreground">
                Create a GitHub App once for this Wrenly instance. GitHub will
                ask you to confirm its name and source permissions.
              </p>
              <label className="block space-y-2">
                <span className="text-sm">GitHub App name</span>
                <Input
                  value={name}
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowOtherAccounts}
                  onChange={(event) =>
                    setAllowOtherAccounts(event.target.checked)
                  }
                  disabled={busy}
                />
                Let members connect their own GitHub accounts using this
                instance’s App. Everyone authorizes their own repository access.
                The App becomes publicly installable; repositories and this
                instance stay private.
              </label>
              <Button
                disabled={busy || name.trim().length < 3}
                onClick={() => void begin("register")}
              >
                Register on GitHub <ArrowUpRightIcon size={14} />
              </Button>
            </div>
          ) : (
            <p>
              The instance owner needs to register its GitHub App before you can
              connect your account.
            </p>
          )
        ) : null}
        {current?.app ? (
          <div className="space-y-3">
            <div className={styles.actions}>
              {!current.connection || current.connection.needsAuthorization ? (
                <Button disabled={busy} onClick={() => void begin("connect")}>
                  {current.connection ? "Authorize again" : "Connect GitHub"}{" "}
                  <ArrowUpRightIcon size={14} />
                </Button>
              ) : (
                <Button
                  className={styles.primary}
                  disabled={busy}
                  onClick={() => void checkRepositories()}
                >
                  Check repository access
                </Button>
              )}
              <a
                className={styles.repositoryLink}
                href={`https://github.com/apps/${current.app.slug}/installations/new`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Choose repositories on GitHub ↗
              </a>
            </div>
            <p className="text-xs text-muted-foreground">
              Select repositories in GitHub, then return here to check access.
              Disconnecting here removes local access; uninstalling the App is
              managed in GitHub.
            </p>
            {current.connection && (
              <details className={styles.advanced}>
                <summary>Connection settings</summary>
                <p>
                  Reconnect if authorization has expired. Disconnect removes
                  your saved Wrenly access; it does not delete repositories.
                </p>
                <div className={styles.actions}>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void begin("connect")}
                  >
                    Reconnect GitHub
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void disconnect()}
                  >
                    Disconnect account
                  </Button>
                </div>
              </details>
            )}
          </div>
        ) : null}
        {repositories ? (
          <div className="rounded-xl border border-border p-4">
            <h3 className="text-sm font-medium">Repository access</h3>
            {repositories.length ? (
              <ul className="mt-2 space-y-2 text-sm">
                {repositories.map((name) => (
                  <li key={name} className="break-all">
                    {name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm">
                No repositories are available yet. Choose repositories on
                GitHub, then check again.
              </p>
            )}
          </div>
        ) : null}
        {current?.importLimits ? (
          <section className={styles.limitsCard} aria-label="GitHub import limits">
            <div className={styles.limitsHeader}>
              <h3>Repository import size limits</h3>
              <span className={styles.badgeAvailable}>
                Active:{" "}
                {IMPORT_LIMIT_OPTIONS.find((item) => item.id === activePreset)
                  ?.title ?? activePreset}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Defaults start at 8 MB source text, 12 MB assets, and 1,000 files
              to keep GitHub review reads responsive and revision snapshots
              compact in PostgreSQL. Because you self-host this infrastructure,
              sliding toward Unlimited lets larger repositories and monorepos
              import cleanly—expect higher memory, PostgreSQL storage, and
              Docker build disk usage on large imports.
            </p>
            <div className={styles.limitSliderWrap}>
              <div className={styles.limitTrackBox}>
                <div className={styles.limitRailFrame} aria-hidden="true">
                  <div className={styles.limitRailBg} />
                  <div
                    className={styles.limitRailFill}
                    style={{
                      width: `${(selectedOptionIndex / (IMPORT_LIMIT_OPTIONS.length - 1)) * 100}%`,
                    }}
                  />
                  {IMPORT_LIMIT_OPTIONS.map((option, index) => (
                    <span
                      key={option.id}
                      className={styles.limitStopDot}
                      data-reached={
                        index <= selectedOptionIndex ? "true" : "false"
                      }
                      style={{
                        left: `${(index / (IMPORT_LIMIT_OPTIONS.length - 1)) * 100}%`,
                      }}
                    />
                  ))}
                </div>
                <input
                  type="range"
                  min={0}
                  max={IMPORT_LIMIT_OPTIONS.length - 1}
                  step={1}
                  value={selectedOptionIndex}
                  aria-label="GitHub import size limit profile"
                  className={styles.limitRange}
                  disabled={busy || !canManageLimits}
                  onChange={(event) => {
                    const nextOption =
                      IMPORT_LIMIT_OPTIONS[Number(event.target.value)];
                    if (nextOption) {
                      setSelectedPreset(nextOption.id);
                      setLimitsMessage(null);
                    }
                  }}
                />
              </div>
              <div className={styles.limitStops}>
                {IMPORT_LIMIT_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={styles.limitStop}
                    aria-pressed={effectivePreset === option.id}
                    disabled={busy || !canManageLimits}
                    onClick={() => {
                      setSelectedPreset(option.id);
                      setLimitsMessage(null);
                    }}
                  >
                    <span className={styles.limitStopTitle}>
                      {option.title}
                    </span>
                    <span className={styles.limitStopBadge}>
                      {option.badge}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.limitDetailCard}>
              <div className={styles.limitDetailTop}>
                <div className={styles.limitDetailTitleRow}>
                  <span>{selectedOption.title} profile</span>
                  <span className="connection-state">{selectedOption.badge}</span>
                </div>
                <span
                  className={
                    effectivePreset === activePreset
                      ? styles.badgeActive
                      : styles.badgeWarning
                  }
                >
                  {effectivePreset === activePreset
                    ? "Currently active"
                    : "Unsaved selection"}
                </span>
              </div>
              <p className={styles.limitDetailDesc}>
                {selectedOption.description}
              </p>
              <div className={styles.limitsMetrics}>
                <div className={styles.limitMetricCell}>
                  <span>Max files</span>
                  <strong>{previewLimits.files.toLocaleString()}</strong>
                </div>
                <div className={styles.limitMetricCell}>
                  <span>Max source text</span>
                  <strong>{formatLimitBytes(previewLimits.totalBytes)}</strong>
                </div>
                <div className={styles.limitMetricCell}>
                  <span>Max assets</span>
                  <strong>{formatLimitBytes(previewLimits.assetBytes)}</strong>
                </div>
                <div className={styles.limitMetricCell}>
                  <span>Max single file</span>
                  <strong>
                    {formatLimitBytes(
                      Math.max(
                        previewLimits.fileBytes,
                        previewLimits.assetFileBytes,
                      ),
                    )}
                  </strong>
                </div>
              </div>
            </div>
            {canManageLimits ? (
              <div className={styles.actions}>
                <Button
                  className={styles.primary}
                  disabled={busy || effectivePreset === activePreset}
                  onClick={() =>
                    void updateImportLimits(
                      { preset: effectivePreset },
                      "GitHub import limits updated.",
                    )
                  }
                >
                  Save import limits
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || activePreset === "default"}
                  onClick={() =>
                    void updateImportLimits(
                      { reset: true },
                      "GitHub import limits reset to Standard defaults.",
                    )
                  }
                >
                  Reset to defaults
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Only the instance owner can change import limits.
              </p>
            )}
            {limitsMessage ? (
              <p role="status" className={styles.alertSuccess}>
                <span className={styles.dotActive} aria-hidden="true" />
                <span>{limitsMessage}</span>
              </p>
            ) : null}
          </section>
        ) : null}
        {busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            Working on your connection…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className={styles.alertError}>
            {error}
          </p>
        ) : null}
        <DocumentationLink guide="guides/github">
          GitHub connection guide →
        </DocumentationLink>
      </div>
    </article>
  );
}
