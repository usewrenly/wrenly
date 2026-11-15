"use client";
/** A review pins the commit; only explicit confirmation creates a project or queues Docker validation. */
import Image from "next/image";
import { ArrowRight, FolderGit2, Check } from "lucide-react";
import styles from "./github-import.module.css";
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
      }),
    )
    .max(200),
});
const Review = z.object({
  repository: z.object({ owner: z.string(), name: z.string() }),
  reviewId: z.uuid(),
  commitId: z.string().regex(/^[a-f0-9]{40}$/),
  fileCount: z.number().int().positive(),
  excludedPaths: z.array(z.string()),
  expiresAt: z.string().datetime(),
});
type ImportReview = z.infer<typeof Review>;
export function GitHubImportButton(): React.JSX.Element {
  const { data: session } = authClient.useSession();
  return <ImportFlow key={session?.user.id ?? "signed-out"} />;
}
function ImportFlow(): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<
    z.infer<typeof Repositories>["repositories"]
  >([]);
  const [repositoryId, setRepositoryId] = useState(""),
    [ref, setRef] = useState("main"),
    [stack, setStack] = useState("nextjs"),
    [name, setName] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [review, setReview] = useState<ImportReview | null>(null);
  const command = useRef<{
    requestId: string;
    reviewId: string;
    name: string;
  } | null>(null);
  const locked = useRef(false);
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
  async function load(): Promise<void> {
    await act(async () => {
      const value = Repositories.parse(
        await responseValue(
          await apiFetch("/api/source/github/repositories", {
            signal: AbortSignal.timeout(35000),
          }),
        ),
      );
      setRepositories(value.repositories);
    });
  }
  async function prepare(): Promise<void> {
    await act(async () => {
      const value = Review.parse(
        await responseValue(
          await apiFetch("/api/source/github/import/review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repositoryId, ref, stack }),
            signal: AbortSignal.timeout(70000),
          }),
        ),
      );
      command.current = {
        requestId: crypto.randomUUID(),
        reviewId: value.reviewId,
        name: name.trim(),
      };
      setReview(value);
    });
  }
  async function confirm(): Promise<void> {
    await act(async () => {
      if (!command.current) throw new Error("Review the import first.");
      setUncertain(true);
      try {
        const value = z
          .object({ projectId: z.uuid(), buildId: z.uuid() })
          .parse(
            await responseValue(
              await apiFetch("/api/source/github/import/confirm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(command.current),
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
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent className={styles.content}>
          <DialogHeader>
            <div className={styles.mark}>
              <Image
                src="/connectors/github.svg"
                alt=""
                width={23}
                height={23}
              />
            </div>
            <DialogTitle>Start with your repository</DialogTitle>
            <DialogDescription>
              Bring an existing app into a private Wrenly project. Review the
              source first, then import and check it before making changes.
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
              <span className={styles.stepNumber}>2</span> Review & import
            </li>
          </ol>
          {!review ? (
            <div className={styles.fields}>
              <div className={styles.access}>
                <Link
                  className={styles.connectionLink}
                  href="/settings/connections"
                >
                  Manage GitHub connection{" "}
                  <ArrowRight size={13} aria-hidden="true" />
                </Link>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void load()}
                >
                  {busy ? "Loading…" : "Load repositories"}
                </Button>
              </div>
              <label className={styles.fieldLabel}>Repository</label>
              <ChoiceSelect
                popupClassName={styles.repositoryPopup}
                label="Repository"
                value={repositoryId || null}
                options={repositories.map((repo) => ({
                  value: repo.id,
                  label: `${repo.owner}/${repo.name}`,
                }))}
                onChange={setRepositoryId}
                disabled={busy || !repositories.length}
              />
              <label className={styles.fieldLabel}>
                Branch or commit{" "}
                <span className={styles.optional}>Use main or a commit ID</span>
                <Input
                  value={ref}
                  onChange={(event) => setRef(event.target.value)}
                  maxLength={120}
                  disabled={busy}
                />
              </label>
              <div className={styles.sectionHeading}>
                <FolderGit2 size={15} aria-hidden="true" /> Your Wrenly project
              </div>
              <label className={styles.fieldLabel}>Framework</label>
              <ChoiceSelect
                label="Framework"
                value={stack}
                options={[
                  { value: "nextjs", label: "Next.js 15" },
                  { value: "laravel", label: "Laravel 13" },
                ]}
                onChange={setStack}
                disabled={busy}
              />
              <label className={styles.fieldLabel}>
                Project name
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={100}
                  disabled={busy}
                  placeholder="My imported app"
                />
              </label>
              <p className={styles.note}>
                Choose the framework used by this repository. Wrenly checks
                compatibility during review; it does not convert the app.
              </p>
              <details className={styles.note}>
                <summary>Supported source and privacy</summary>
                <p>
                  Root applications only. Binary assets, submodules and Git LFS
                  are unsupported. Private configuration is excluded. No
                  dependencies run during review.
                </p>
              </details>
              {!repositories.length && (
                <p className={styles.note}>
                  Connect GitHub and load the repositories you allowed this App
                  to access.
                </p>
              )}
              <Button
                className={styles.primary}
                disabled={busy || !repositoryId || !ref || !name.trim()}
                onClick={() => void prepare()}
              >
                {busy ? "Reading source…" : "Review this source"}
              </Button>
            </div>
          ) : (
            <div className={styles.fields}>
              <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                <p className="font-medium">{command.current?.name}</p>
                <p className="text-sm">
                  {review.repository.owner}/{review.repository.name}
                </p>
                <p className="text-sm">
                  {review.fileCount} source files · Private project
                </p>
                <p className="break-all font-mono text-xs">
                  Commit {review.commitId}
                </p>
                <p className="text-sm text-muted-foreground">
                  Review expires{" "}
                  {new Date(review.expiresAt).toLocaleTimeString()}.
                </p>
              </div>
              {review.excludedPaths.length > 0 && (
                <details className="text-sm">
                  <summary>
                    {review.excludedPaths.length} private/configuration files
                    excluded
                  </summary>
                  <ul className="max-h-32 overflow-auto font-mono text-xs">
                    {review.excludedPaths.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="text-sm text-muted-foreground">
                Import saves these files and queues validation. A failed build
                preserves the source so you can inspect it and explicitly
                request changes.
              </p>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  disabled={busy || uncertain}
                  onClick={() => {
                    setReview(null);
                    command.current = null;
                  }}
                >
                  Back
                </Button>
                <Button
                  className={styles.primary}
                  disabled={busy}
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
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
            >
              {error}
              {review
                ? " Retry keeps the same request, so a lost reply cannot create a duplicate project."
                : ""}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
