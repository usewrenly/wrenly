"use client";
/** A review pins the commit; only explicit confirmation creates a project or queues Docker validation. */
import Image from "next/image";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  FolderGit2,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import styles from "./github-import.module.css";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import {
  readSourceResponse as responseValue,
  SourceResponseError as ImportResponseError,
} from "@/lib/source-control/response";
import { authClient } from "@/lib/auth/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChoiceSelect } from "@/components/ui/choice-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const Repositories = z.object({
  repositories: z
    .array(
      z.object({
        id: z.string().regex(/^[1-9][0-9]*$/),
        owner: z.string(),
        name: z.string(),
        sizeKb: z.number().int().nonnegative().optional(),
      }),
    )
    .max(200),
});

const RiskFlagSchema = z.object({
  code: z.string(),
  title: z.string(),
  detail: z.string(),
  paths: z.array(z.string()),
});

const Review = z.object({
  stack: z.enum(["nextjs", "laravel"]),
  applicationRoot: z.string(),
  repository: z.object({ owner: z.string(), name: z.string() }),
  reviewId: z.uuid(),
  commitId: z.string().regex(/^[a-f0-9]{40}$/),
  fileCount: z.number().int().positive(),
  assetCount: z.number().int().nonnegative().default(0),
  textBytes: z.number().int().nonnegative().optional(),
  assetBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  riskFlags: z.array(RiskFlagSchema).default([]),
  excludedPaths: z.array(z.string()),
  expiresAt: z.string().datetime(),
});

type ImportReview = z.infer<typeof Review>;
type ImportMode = "clean" | "with_risks";

function formatSizeKb(sizeKb?: number): string {
  if (typeof sizeKb !== "number" || !Number.isFinite(sizeKb)) return "";
  if (sizeKb >= 1024 * 1024) {
    return `${(sizeKb / (1024 * 1024)).toFixed(1)} GB`;
  }
  if (sizeKb >= 1024) {
    return `${(sizeKb / 1024).toFixed(1)} MB`;
  }
  return `${Math.max(1, sizeKb).toLocaleString()} KB`;
}

function formatBytes(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;
  }
  return `${bytes} B`;
}

export function GitHubImportButton(): React.JSX.Element {
  const { data: session } = authClient.useSession();
  return (
    <ImportFlow
      key={session?.user.id ?? "signed-out"}
      userId={session?.user.id}
    />
  );
}

function ImportFlow({
  userId,
}: {
  userId: string | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [repositoryId, setRepositoryId] = useState(""),
    [ref, setRef] = useState(""),
    [applicationRoot, setApplicationRoot] = useState(""),
    [stack, setStack] = useState("auto"),
    [name, setName] = useState(""),
    [nameEdited, setNameEdited] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [repositorySearch, setRepositorySearch] = useState("");
  const comboboxRef = useRef<HTMLDivElement | null>(null);

  const [importMode, setImportMode] = useState<ImportMode>("clean");
  const [riskConsent, setRiskConsent] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [review, setReview] = useState<ImportReview | null>(null);
  const command = useRef<{
    key: string;
    requestId: string;
  } | null>(null);
  const locked = useRef(false);

  const repoQuery = useQuery({
    queryKey: ["source-github-repositories", userId],
    enabled: open && Boolean(userId),
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }) => {
      const value = Repositories.parse(
        await responseValue(
          await apiFetch("/api/source/github/repositories", {
            signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
          }),
        ),
      );
      return value.repositories;
    },
  });
  const repositories = repoQuery.data ?? [];
  const loadingRepos = repoQuery.isFetching;
  const repoError =
    repoQuery.error instanceof Error ? repoQuery.error.message : null;
  const displayError = error ?? repoError;

  const visibleRepositories = repositories.filter((repo) =>
    `${repo.owner}/${repo.name}`
      .toLowerCase()
      .includes(repositorySearch.trim().toLowerCase()),
  );
  const selectedRepository = repositories.find(
    (repo) => repo.id === repositoryId,
  );

  useEffect(() => {
    if (!dropdownOpen) return;
    function onPointerDown(event: MouseEvent): void {
      if (
        comboboxRef.current &&
        event.target instanceof Node &&
        !comboboxRef.current.contains(event.target)
      ) {
        setDropdownOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dropdownOpen]);

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
          : "Import could not be checked.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function refreshRepositories(): Promise<void> {
    if (busy || loadingRepos) return;
    setError(null);
    await repoQuery.refetch();
  }

  function selectRepository(
    repo: z.infer<typeof Repositories>["repositories"][number],
  ): void {
    setRepositoryId(repo.id);
    setRef("");
    setError(null);
    setDropdownOpen(false);
    setRepositorySearch("");
    if (!nameEdited || !name.trim()) {
      setName(repo.name);
    }
  }

  async function prepare(): Promise<void> {
    await act(async () => {
      const value = Review.parse(
        await responseValue(
          await apiFetch("/api/source/github/import/review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repositoryId, ref, stack, applicationRoot }),
            signal: AbortSignal.timeout(195000),
          }),
        ),
      );
      command.current = null;
      setImportMode("clean");
      setRiskConsent(false);
      setReview(value);
    });
  }

  async function confirm(): Promise<void> {
    await act(async () => {
      if (!review) throw new Error("Review the import first.");
      const trimmedName = name.trim();
      const key = `${review.reviewId}:${trimmedName}:${importMode}:${riskConsent}`;
      if (!command.current || command.current.key !== key) {
        command.current = {
          key,
          requestId: crypto.randomUUID(),
        };
      }
      setUncertain(true);
      try {
        const body =
          importMode === "with_risks"
            ? {
                requestId: command.current.requestId,
                reviewId: review.reviewId,
                name: trimmedName,
                importMode: "with_risks" as const,
                riskConsent,
              }
            : {
                requestId: command.current.requestId,
                reviewId: review.reviewId,
                name: trimmedName,
                importMode: "clean" as const,
              };
        const value = z
          .object({ projectId: z.uuid(), buildId: z.uuid() })
          .parse(
            await responseValue(
              await apiFetch("/api/source/github/import/confirm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(15000),
              }),
            ),
          );
        router.push(`/p/${value.projectId}?build=${value.buildId}`);
      } catch (failure) {
        if (
          failure instanceof ImportResponseError &&
          failure.status >= 400 &&
          failure.status < 500
        )
          setUncertain(false);
        throw failure;
      }
    });
  }

  const hasRisksOrExclusions = Boolean(
    review && (review.riskFlags.length > 0 || review.excludedPaths.length > 0),
  );
  const needsLimitLink = Boolean(
    displayError && /limit|size|Settings|Connections/i.test(displayError),
  );
  const confirmDisabled =
    busy || (importMode === "with_risks" && !riskConsent);

  return (
    <>
      <Button
        variant="ghost"
        className={styles.trigger}
        onClick={() => setOpen(true)}
      >
        <Image src="/connectors/github.svg" alt="" width={16} height={16} />{" "}
        Import from GitHub
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) {
            setOpen(next);
            if (!next) setDropdownOpen(false);
          }
        }}
      >
        <DialogContent className={`sm:max-w-[760px] ${styles.content}`}>
          <DialogHeader>
            <div className={styles.mark}>
              <Image
                src="/connectors/github.svg"
                alt=""
                width={22}
                height={22}
              />
            </div>
            <DialogTitle>Start with your repository</DialogTitle>
            <DialogDescription>
              Bring an existing app into a private Wrenly project. Review
              source size, detected security notices, and build settings before
              importing.
            </DialogDescription>
          </DialogHeader>

          <ol className={styles.steps} aria-label="Import steps">
            <li className={!review ? "text-foreground" : ""}>
              <span className={styles.stepNumber}>
                {review ? <Check size={12} /> : "1"}
              </span>{" "}
              Choose source
            </li>
            <li className={review ? "text-foreground" : ""}>
              <span className={styles.stepNumber}>2</span> Review &amp; import
            </li>
          </ol>

          {displayError && (
            <div role="alert" className={styles.errorBanner}>
              <div className={styles.errorBannerHeader}>
                <AlertCircle size={16} aria-hidden="true" />
                <span>
                  {displayError}
                  {review
                    ? " Retry keeps the same request, so a lost reply cannot create a duplicate project."
                    : ""}
                </span>
              </div>
              {needsLimitLink && (
                <Link
                  href="/settings/connections"
                  className={styles.errorLink}
                  onClick={() => setOpen(false)}
                >
                  Adjust import limits in Connections →
                </Link>
              )}
            </div>
          )}

          {!review ? (
            <div className={styles.fields}>
              <div className={styles.access}>
                <Link
                  className={styles.connectionLink}
                  href="/settings/connections"
                  onClick={() => setOpen(false)}
                >
                  Manage GitHub connection &amp; limits{" "}
                  <ArrowRight size={13} aria-hidden="true" />
                </Link>
                <Button
                  variant="outline"
                  disabled={busy || loadingRepos}
                  onClick={() => void refreshRepositories()}
                >
                  <RefreshCw
                    size={13}
                    className={loadingRepos ? "animate-spin" : undefined}
                    aria-hidden="true"
                  />{" "}
                  {loadingRepos ? "Refreshing…" : "Refresh"}
                </Button>
              </div>

              <div className={styles.fieldGroup} ref={comboboxRef}>
                <label className={styles.fieldLabel} htmlFor="repo-picker-btn">
                  Repository
                </label>
                <div className={styles.combobox}>
                  <button
                    id="repo-picker-btn"
                    type="button"
                    className={styles.repoTrigger}
                    aria-haspopup="listbox"
                    aria-expanded={dropdownOpen}
                    disabled={busy || repositories.length === 0}
                    onClick={() => setDropdownOpen((prev) => !prev)}
                  >
                    <span className={styles.repoTriggerMain}>
                      <Image
                        src="/connectors/github.svg"
                        alt=""
                        width={16}
                        height={16}
                      />
                      <span>
                        {selectedRepository
                          ? `${selectedRepository.owner}/${selectedRepository.name}`
                          : loadingRepos
                            ? "Loading repositories…"
                            : repositories.length > 0
                              ? "Select a repository…"
                              : repoError
                                ? "GitHub connection required"
                                : "No repositories found"}
                      </span>
                    </span>
                    <span className={styles.repoTriggerMeta}>
                      {selectedRepository?.sizeKb !== undefined && (
                        <span className={styles.sizeBadge}>
                          {formatSizeKb(selectedRepository.sizeKb)}
                        </span>
                      )}
                      <ChevronDown size={15} aria-hidden="true" />
                    </span>
                  </button>

                  {dropdownOpen && repositories.length > 0 && (
                    <div className={styles.repoMenu}>
                      <div className={styles.repoSearchWrap}>
                        <Search size={14} aria-hidden="true" />
                        <input
                          type="search"
                          autoFocus
                          value={repositorySearch}
                          onChange={(event) =>
                            setRepositorySearch(event.target.value)
                          }
                          placeholder="Search repositories by owner or name…"
                          aria-label="Search repositories"
                          className={styles.repoSearchInput}
                          maxLength={200}
                        />
                      </div>
                      <div
                        className={styles.repoList}
                        role="listbox"
                        aria-label="Repositories"
                      >
                        {visibleRepositories.length > 0 ? (
                          visibleRepositories.map((repo) => {
                            const selected = repo.id === repositoryId;
                            return (
                              <button
                                key={repo.id}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                className={styles.repoOption}
                                onClick={() => selectRepository(repo)}
                              >
                                <span className={styles.repoOptionLeft}>
                                  <Image
                                    src="/connectors/github.svg"
                                    alt=""
                                    width={15}
                                    height={15}
                                  />
                                  <span className={styles.repoOptionName}>
                                    <span className={styles.repoOptionOwner}>
                                      {repo.owner}/
                                    </span>
                                    <strong>{repo.name}</strong>
                                  </span>
                                </span>
                                <span className={styles.repoOptionRight}>
                                  {repo.sizeKb !== undefined && (
                                    <span className={styles.sizeBadge}>
                                      {formatSizeKb(repo.sizeKb)}
                                    </span>
                                  )}
                                  {selected && (
                                    <Check size={14} aria-hidden="true" />
                                  )}
                                </span>
                              </button>
                            );
                          })
                        ) : (
                          <div className={styles.repoEmpty}>
                            No matching repositories found.
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className={styles.fieldGrid}>
                <label className={styles.fieldLabel}>
                  Branch or commit
                  <span className={styles.optional}>
                    Optional · leave empty for default branch
                  </span>
                  <Input
                    value={ref}
                    placeholder="Repository default branch"
                    onChange={(event) => setRef(event.target.value)}
                    maxLength={120}
                    disabled={busy}
                  />
                </label>
                <label className={styles.fieldLabel}>
                  Application directory
                  <span className={styles.optional}>
                    Optional · leave empty for repo root
                  </span>
                  <Input
                    value={applicationRoot}
                    onChange={(event) => setApplicationRoot(event.target.value)}
                    placeholder="apps/web"
                    maxLength={400}
                    disabled={busy}
                  />
                </label>
              </div>

              <div className={styles.sectionHeading}>
                <FolderGit2 size={15} aria-hidden="true" /> Your Wrenly project
              </div>

              <div className={styles.fieldGrid}>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>Framework</label>
                  <ChoiceSelect
                    label="Framework"
                    value={stack}
                    options={[
                      { value: "auto", label: "Detect automatically" },
                      { value: "nextjs", label: "Next.js" },
                      { value: "laravel", label: "Laravel" },
                    ]}
                    onChange={setStack}
                    disabled={busy}
                  />
                </div>
                <label className={styles.fieldLabel}>
                  Project name
                  <Input
                    value={name}
                    onChange={(event) => {
                      const val = event.target.value;
                      setName(val);
                      setNameEdited(val.trim().length > 0);
                    }}
                    maxLength={100}
                    disabled={busy}
                    placeholder="Auto-filled from repository"
                  />
                </label>
              </div>

              <p className={styles.note}>
                Wrenly detects your framework from repository manifests and
                flags private secrets, caches, or version notes before importing.
              </p>

              <div className={styles.footerActions}>
                <Button
                  className={styles.primary}
                  disabled={busy || !repositoryId || !name.trim()}
                  onClick={() => void prepare()}
                >
                  {busy
                    ? "Inspecting source… larger repos may take a moment"
                    : "Review this source"}
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.fields}>
              <div className={styles.reviewCard}>
                <div className={styles.reviewHeader}>
                  <div>
                    <p className="text-base font-semibold text-foreground">
                      {name.trim() || review.repository.name}
                    </p>
                    <p className={styles.reviewRepo}>
                      <Image
                        src="/connectors/github.svg"
                        alt=""
                        width={14}
                        height={14}
                      />
                      <span>
                        {review.repository.owner}/{review.repository.name}
                      </span>
                    </p>
                  </div>
                  <span className={styles.sizeBadge}>
                    Commit {review.commitId.slice(0, 8)}
                  </span>
                </div>

                <div className={styles.reviewMetrics}>
                  <div>
                    <span className={styles.metricLabel}>Framework</span>
                    <span className={styles.metricValue}>
                      {review.stack === "nextjs" ? "Next.js" : "Laravel"}
                    </span>
                  </div>
                  <div>
                    <span className={styles.metricLabel}>Imported size</span>
                    <span className={styles.metricValue}>
                      {formatBytes(review.totalBytes)}
                    </span>
                    <span className={styles.metricSub}>
                      {formatBytes(review.textBytes)} code ·{" "}
                      {formatBytes(review.assetBytes)} assets
                    </span>
                  </div>
                  <div>
                    <span className={styles.metricLabel}>Files included</span>
                    <span className={styles.metricValue}>
                      {review.fileCount.toLocaleString()} files
                    </span>
                    {review.assetCount > 0 && (
                      <span className={styles.metricSub}>
                        {review.assetCount} media/font assets
                      </span>
                    )}
                  </div>
                  <div>
                    <span className={styles.metricLabel}>Directory</span>
                    <span className={styles.metricValue}>
                      {review.applicationRoot || "/"}
                    </span>
                    <span className={styles.metricSub}>
                      Expires {new Date(review.expiresAt).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              </div>

              {hasRisksOrExclusions ? (
                <section className={styles.riskPanel}>
                  <div className={styles.riskTitle}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>
                      Review notices &amp; excluded items before importing
                    </span>
                  </div>

                  {review.riskFlags.length > 0 && (
                    <div className={styles.riskList}>
                      {review.riskFlags.map((flag) => (
                        <div className={styles.riskItem} key={flag.code}>
                          <strong>{flag.title}</strong>
                          <p>{flag.detail}</p>
                          {flag.paths.length > 0 && (
                            <div className={styles.riskPaths}>
                              {flag.paths.slice(0, 8).map((path) => (
                                <code className={styles.riskPathChip} key={path}>
                                  {path}
                                </code>
                              ))}
                              {flag.paths.length > 8 && (
                                <span className={styles.riskPathChip}>
                                  +{flag.paths.length - 8} more
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {review.excludedPaths.length > 0 && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer font-medium text-foreground">
                        {review.excludedPaths.length} excluded or sanitized
                        paths
                      </summary>
                      <ul className="mt-2 max-h-32 overflow-auto font-mono text-xs">
                        {review.excludedPaths.map((path) => (
                          <li key={path}>{path}</li>
                        ))}
                      </ul>
                    </details>
                  )}

                  <div className={styles.modeGrid}>
                    <button
                      type="button"
                      className={styles.modeCard}
                      aria-pressed={importMode === "clean"}
                      disabled={busy}
                      onClick={() => {
                        setImportMode("clean");
                        setRiskConsent(false);
                      }}
                    >
                      <strong>
                        Clean import without risky items (Recommended)
                      </strong>
                      <span>
                        Keeps excluded private envs, caches, dependencies, and
                        unsafe install scripts out of your workspace.
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.modeCard}
                      aria-pressed={importMode === "with_risks"}
                      disabled={busy}
                      onClick={() => setImportMode("with_risks")}
                    >
                      <strong>Consent &amp; mark project with risks</strong>
                      <span>
                        Imports with your explicit acknowledgement and labels
                        this project as having security risks reviewed.
                      </span>
                    </button>
                  </div>

                  {importMode === "with_risks" && (
                    <label className={styles.consentLabel}>
                      <input
                        type="checkbox"
                        checked={riskConsent}
                        onChange={(event) =>
                          setRiskConsent(event.target.checked)
                        }
                        disabled={busy}
                      />
                      <span>
                        I understand these repository findings and consent to
                        importing and marking this project as carrying reviewed
                        security risks on my infrastructure.
                      </span>
                    </label>
                  )}
                </section>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                  <ShieldCheck size={15} aria-hidden="true" />
                  <span>
                    No private environment files, runtime caches, or risky
                    manifest entries were detected.
                  </span>
                </div>
              )}

              <p className={styles.note}>
                Confirming saves this pinned snapshot into a private Wrenly
                project and queues isolated Docker validation.
              </p>

              <div className={styles.footerActions}>
                <Button
                  variant="outline"
                  disabled={busy || uncertain}
                  onClick={() => {
                    setReview(null);
                    setError(null);
                    command.current = null;
                  }}
                >
                  Back
                </Button>
                <Button
                  className={styles.primary}
                  disabled={confirmDisabled}
                  onClick={() => void confirm()}
                >
                  {busy
                    ? "Saving import…"
                    : error
                      ? "Retry same import"
                      : "Import & validate"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
