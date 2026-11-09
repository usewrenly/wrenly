"use client";
/** Owner source controls preserve one reviewed request across lost acknowledgements. */
import { useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { authClient } from "@/lib/auth/auth-client";
import { apiFetch } from "@/lib/api";
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
const Repository = z.object({
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
});
const Status = z.object({
  project: z.object({
    id: z.uuid(),
    name: z.string(),
    stack: z.enum(["nextjs", "laravel", "vue", "django"]),
    revision: z.uuid(),
  }),
  origin: z.object({ repository: Repository, commitId: z.string() }).nullable(),
  operations: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum([
        "queued",
        "running",
        "success",
        "needs_review",
        "failed",
      ]),
      phase: z.string(),
      branch: z.string(),
      commitId: z.string().nullable(),
      repository: Repository,
    }),
  ),
});
const Review = z.object({
  reviewId: z.uuid(),
  repository: Repository,
  baseCommit: z.string(),
  branch: z.string(),
  changes: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("delete"),
        path: z.string(),
        previousContent: z.string().nullable().optional(),
      }),
      z.object({
        kind: z.enum(["add", "update"]),
        path: z.string(),
        content: z.string(),
        previousContent: z.string().nullable().optional(),
      }),
    ]),
  ),
  expiresAt: z.string().datetime(),
});
class SourceResponseError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function read(response: Response): Promise<unknown> {
  const raw: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(raw);
    throw new SourceResponseError(
      response.status,
      error.success
        ? error.data.error
        : "Source operation could not be checked.",
    );
  }
  return raw;
}
async function post(
  path: `/api/${string}`,
  body: unknown,
  timeout = 15000,
): Promise<unknown> {
  return read(
    await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    }),
  );
}
export function GitHubSourceButton({
  projectId,
  buildId,
}: {
  projectId: string;
  buildId: string;
}): React.JSX.Element {
  const { data: session } = authClient.useSession();
  return (
    <SourceFlow
      key={`${session?.user.id ?? ""}:${projectId}:${buildId}`}
      userId={session?.user.id}
      projectId={projectId}
      buildId={buildId}
    />
  );
}
function SourceFlow({
  projectId,
  buildId,
  userId,
}: {
  projectId: string;
  buildId: string;
  userId: string | undefined;
}): React.JSX.Element {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [uncertain, setUncertain] = useState(false);
  const [branch, setBranch] = useState(
    `wrenly/${projectId.slice(0, 8)}-${buildId.slice(0, 8)}`,
  );
  const [repositories, setRepositories] = useState<
      Array<{ id: string; owner: string; name: string }>
    >([]),
    [repositoryId, setRepositoryId] = useState(""),
    [ref, setRef] = useState("main");
  const [bindingReview, setBindingReview] = useState<{
    reviewId: string;
    commitId: string;
    repository: z.infer<typeof Repository>;
  } | null>(null);
  const [review, setReview] = useState<z.infer<typeof Review> | null>(null),
    [recoveryId, setRecoveryId] = useState<string | null>(null);
  const locked = useRef(false),
    command = useRef<Record<string, string> | null>(null);
  const status = useQuery({
    queryKey: ["github-project", userId, projectId],
    enabled: open && Boolean(userId),
    retry: false,
    queryFn: async () =>
      Status.parse(
        await read(
          await apiFetch(`/api/source/github/project?projectId=${projectId}`, {
            signal: AbortSignal.timeout(15000),
          }),
        ),
      ),
    refetchInterval: (query) =>
      uncertain ||
      query.state.data?.operations.some(
        (op) => op.status === "queued" || op.status === "running",
      )
        ? 2000
        : false,
  });
  async function act(run: () => Promise<void>): Promise<void> {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (failure) {
      if (failure instanceof SourceResponseError && failure.status < 500)
        setUncertain(false);
      setError(
        failure instanceof Error
          ? failure.message
          : "Source operation could not be checked.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function prepareBinding(): Promise<void> {
    await act(async () => {
      if (!status.data) return;
      const raw = await post(
        "/api/source/github/import/review",
        { repositoryId, ref, stack: status.data.project.stack },
        70000,
      );
      const binding = z
        .object({
          reviewId: z.uuid(),
          commitId: z.string(),
          repository: Repository,
        })
        .parse(raw);
      command.current = {
        projectId,
        buildId,
        expectedRevision: status.data.project.revision,
        reviewId: binding.reviewId,
        requestId: crypto.randomUUID(),
      };
      setBindingReview(binding);
    });
  }
  async function confirmBinding(): Promise<void> {
    await act(async () => {
      if (!command.current) return;
      setUncertain(true);
      await post("/api/source/github/bind", command.current);
      setUncertain(false);
      setBindingReview(null);
      command.current = null;
      await status.refetch();
    });
  }
  async function preparePush(): Promise<void> {
    await act(async () => {
      if (!status.data) return;
      const value = Review.parse(
        await post("/api/source/github/push/review", {
          projectId,
          buildId,
          expectedRevision: status.data.project.revision,
          branch,
        }),
      );
      command.current = {
        reviewId: value.reviewId,
        requestId: crypto.randomUUID(),
      };
      setReview(value);
    });
  }
  async function confirmPush(): Promise<void> {
    await act(async () => {
      if (!command.current) return;
      setUncertain(true);
      await post("/api/source/github/push/confirm", command.current);
      setUncertain(false);
      setReview(null);
      command.current = null;
      await status.refetch();
    });
  }
  const pending = status.data?.operations.some((op) =>
    ["queued", "running", "needs_review"].includes(op.status),
  );
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        GitHub source
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Project source</DialogTitle>
            <DialogDescription>
              Review saved source before creating a new GitHub branch. This does
              not publish your running app.
            </DialogDescription>
          </DialogHeader>
          {status.isPending ? (
            <p>Reading project source…</p>
          ) : status.isError ? (
            <p role="alert">
              {status.error.message}{" "}
              <Link href="/settings/connections" className="underline">
                Check GitHub connection
              </Link>
            </p>
          ) : (
            status.data && (
              <div className="space-y-5">
                <div className="rounded-lg border bg-muted/30 p-4">
                  <p className="font-medium">{status.data.project.name}</p>
                  <p className="text-sm text-muted-foreground">
                    Selected revision {buildId.slice(0, 8)}
                  </p>
                  {status.data.origin && (
                    <p className="text-sm">
                      {status.data.origin.repository.owner}/
                      {status.data.origin.repository.name} · baseline{" "}
                      {status.data.origin.commitId.slice(0, 8)}
                    </p>
                  )}
                </div>
                {!status.data.origin ? (
                  bindingReview ? (
                    <section className="space-y-3">
                      <h3 className="font-medium">Connect this baseline?</h3>
                      <p className="text-sm">
                        {bindingReview.repository.owner}/
                        {bindingReview.repository.name}
                      </p>
                      <code className="break-all text-xs">
                        {bindingReview.commitId}
                      </code>
                      <p className="text-sm text-muted-foreground">
                        Your local source is preserved. Later pushes compare
                        this repository commit with the selected local revision.
                      </p>
                      <div className="flex gap-3">
                        <Button
                          variant="outline"
                          disabled={busy || uncertain}
                          onClick={() => {
                            setBindingReview(null);
                            command.current = null;
                          }}
                        >
                          Back
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => void confirmBinding()}
                        >
                          {uncertain
                            ? "Retry same connection"
                            : "Connect repository"}
                        </Button>
                      </div>
                    </section>
                  ) : (
                    <section className="space-y-4">
                      <div className="flex justify-between gap-3">
                        <Link
                          className="text-sm underline"
                          href="/settings/connections"
                        >
                          Connect your GitHub account
                        </Link>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const result = z
                                .object({
                                  repositories: z
                                    .array(
                                      z.object({
                                        id: z.string(),
                                        owner: z.string(),
                                        name: z.string(),
                                      }),
                                    )
                                    .max(200),
                                })
                                .parse(
                                  await read(
                                    await apiFetch(
                                      "/api/source/github/repositories",
                                      { signal: AbortSignal.timeout(35000) },
                                    ),
                                  ),
                                );
                              setRepositories(result.repositories);
                            })
                          }
                        >
                          Load repositories
                        </Button>
                      </div>
                      <ChoiceSelect
                        label="Repository"
                        value={repositoryId || null}
                        options={repositories.map((repo) => ({
                          value: repo.id,
                          label: `${repo.owner}/${repo.name}`,
                        }))}
                        onChange={setRepositoryId}
                        disabled={busy || !repositories.length}
                      />
                      <label className="block text-sm space-y-2">
                        Baseline branch or commit
                        <Input
                          value={ref}
                          onChange={(event) => setRef(event.target.value)}
                          maxLength={120}
                          disabled={busy}
                        />
                      </label>
                      <Button
                        disabled={busy || !repositoryId || !ref}
                        onClick={() => void prepareBinding()}
                      >
                        Review repository connection
                      </Button>
                    </section>
                  )
                ) : review ? (
                  <section className="space-y-4">
                    <div>
                      <h3 className="font-medium">Review this push</h3>
                      <p className="text-sm">
                        New branch: <code>{review.branch}</code>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Base {review.baseCommit.slice(0, 8)} · review expires{" "}
                        {new Date(review.expiresAt).toLocaleTimeString()}
                      </p>
                    </div>
                    <div className="max-h-60 space-y-2 overflow-auto">
                      {review.changes.map((change) => (
                        <details
                          className="rounded-lg border p-3 text-sm"
                          key={change.path}
                        >
                          <summary>
                            <span
                              className={
                                change.kind === "delete"
                                  ? "text-destructive"
                                  : "text-foreground"
                              }
                            >
                              {change.kind}
                            </span>{" "}
                            · {change.path}
                          </summary>
                          {change.previousContent != null && (
                            <div className="mt-3">
                              <p className="text-xs text-muted-foreground">
                                Before
                              </p>
                              <pre className="overflow-auto text-xs whitespace-pre-wrap">
                                {change.previousContent}
                              </pre>
                            </div>
                          )}
                          {change.kind !== "delete" && (
                            <pre className="mt-3 overflow-auto text-xs whitespace-pre-wrap">
                              {change.content}
                            </pre>
                          )}
                        </details>
                      ))}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Creates a new branch from this reviewed baseline. The
                      default branch and unmanaged files stay unchanged. Saving
                      a chat does not push code.
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
                        disabled={busy}
                        onClick={() => void confirmPush()}
                      >
                        {uncertain
                          ? "Retry same push request"
                          : "Push to new branch"}
                      </Button>
                    </div>
                  </section>
                ) : (
                  <section className="space-y-3">
                    <label className="block text-sm space-y-2">
                      New branch
                      <Input
                        value={branch}
                        onChange={(event) => setBranch(event.target.value)}
                        maxLength={120}
                        disabled={busy || pending}
                      />
                    </label>
                    <Button
                      disabled={busy || pending}
                      onClick={() => void preparePush()}
                    >
                      Review selected revision
                    </Button>
                  </section>
                )}
                {status.data.operations.length > 0 && (
                  <section className="space-y-3 border-t pt-4">
                    <h3 className="text-sm font-medium">
                      Recent source pushes
                    </h3>
                    {status.data.operations.map((op) => (
                      <div
                        className="rounded-lg border p-3 space-y-2 text-sm"
                        key={op.id}
                      >
                        <div className="flex justify-between gap-3">
                          <code className="break-all">{op.branch}</code>
                          <span>{op.status.replaceAll("_", " ")}</span>
                        </div>
                        {op.status === "success" && (
                          <a
                            className="underline"
                            href={`https://github.com/${op.repository.owner}/${op.repository.name}/tree/${op.commitId}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open pushed revision ↗
                          </a>
                        )}
                        {op.status === "needs_review" && (
                          <>
                            <p className="text-muted-foreground">
                              GitHub may have received this push. Check its
                              branch before confirming that processing has
                              finished. Recovery only reads GitHub; it does not
                              repeat the push.
                            </p>
                            <label className="flex gap-2 items-start">
                              <input
                                type="checkbox"
                                checked={recoveryId === op.id}
                                onChange={(event) =>
                                  setRecoveryId(
                                    event.target.checked ? op.id : null,
                                  )
                                }
                              />
                              I checked GitHub and this push has finished
                              processing.
                            </label>
                            <Button
                              variant="outline"
                              disabled={busy || recoveryId !== op.id}
                              onClick={() =>
                                void act(async () => {
                                  await post(
                                    "/api/source/github/push/recover",
                                    {
                                      operationId: op.id,
                                      confirmRemoteSettled: true,
                                    },
                                    35000,
                                  );
                                  setRecoveryId(null);
                                  await status.refetch();
                                })
                              }
                            >
                              Check saved push result
                            </Button>
                          </>
                        )}
                      </div>
                    ))}
                  </section>
                )}
              </div>
            )
          )}
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
            >
              {error}
              {uncertain
                ? " Keep this request: its result has not been confirmed."
                : ""}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
