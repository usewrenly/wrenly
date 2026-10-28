"use client";
// Creation is an explicit saved idea, never build admission.
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePenLineIcon, PlusIcon } from "lucide-react";
import {
  draftRequest,
  DraftRequestError,
  parseDraft,
  parseDraftList,
} from "@/lib/projects/drafts/project-drafts";
import { relativeTime } from "@/lib/format";
// Refresh shared collection changes without refetching on every keystroke.
const DRAFT_COLLECTION_POLL_MS = 5_000;

/** Uses an unchanged request UUID across ambiguous creation acknowledgements. */
export function DraftCollection(): React.JSX.Element {
  const router = useRouter(),
    cache = useQueryClient();
  const [offset, setOffset] = useState(0),
    [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [uncertain, setUncertain] = useState(false);
  const frozen = useRef<Record<string, unknown> | null>(null),
    lock = useRef(false);
  const query = useQuery({
    queryKey: ["project-drafts", offset],
    retry: false,
    refetchInterval: DRAFT_COLLECTION_POLL_MS,
    queryFn: async ({ signal }) =>
      parseDraftList(
        await draftRequest(`/api/drafts?offset=${offset}`, undefined, signal),
      ),
  });
  const create = async (): Promise<void> => {
    if (lock.current || !title.trim()) return;
    const input = frozen.current ?? {
      requestId: crypto.randomUUID(),
      draftId: crypto.randomUUID(),
      title: title.trim(),
      body: "",
    };
    lock.current = true;
    frozen.current = input;
    setBusy(true);
    setError("");
    try {
      const result = await draftRequest("/api/drafts", input),
        draft = parseDraft(result.draft, String(input.draftId));
      frozen.current = null;
      setUncertain(false);
      await cache.invalidateQueries({ queryKey: ["project-drafts"] });
      router.push(`/projects/drafts/${draft.id}`);
    } catch (error) {
      const unknown =
        !(error instanceof DraftRequestError) ||
        error.status >= 500 ||
        error.status === 408;
      setUncertain(unknown);
      if (!unknown) frozen.current = null;
      setError(
        error instanceof Error
          ? error.message
          : "Draft creation could not be confirmed.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="projects-page">
      <header className="projects-heading">
        <div>
          <p className="home-eyebrow">Ideas deserve a place to start</p>
          <h1>Drafts</h1>
          <p>Capture an idea. Refine it together. Build when you’re ready.</p>
        </div>
      </header>
      <nav className="projects-collection-nav" aria-label="Project collections">
        <Link href="/projects">Projects</Link>
        <Link href="/projects/drafts" aria-current="page">
          Drafts
        </Link>
        <Link href="/projects/deployments">Deployments</Link>
      </nav>
      <form
        className="draft-create"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label htmlFor="draft-title">Give your idea a name</label>
        <div>
          <input
            id="draft-title"
            value={title}
            maxLength={100}
            required
            disabled={busy || uncertain}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="An idea worth coming back to…"
          />
          <button type="submit" disabled={busy || !title.trim()}>
            <PlusIcon size={15} aria-hidden="true" />
            {busy
              ? "Confirming…"
              : uncertain
                ? "Retry same creation"
                : "New draft"}
          </button>
        </div>
        <p>
          Private until you choose to share it. No model or framework needed.
        </p>
      </form>
      {error && (
        <p role="alert" className="settings-notice">
          {error}
        </p>
      )}
      {query.isPending ? (
        <p role="status">Loading drafts…</p>
      ) : query.isError ? (
        <div role="alert">
          <p>{query.error.message}</p>
          <button type="button" onClick={() => void query.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className="draft-collection">
            {query.data.drafts.length ? (
              query.data.drafts.map((draft) => (
                <Link
                  className="draft-card"
                  key={draft.id}
                  href={`/projects/drafts/${draft.id}`}
                >
                  <FilePenLineIcon size={19} aria-hidden="true" />
                  <h2>{draft.title}</h2>
                  <p>
                    {draft.archivedAt
                      ? "Archived"
                      : draft.accessMode === "private"
                        ? "Private"
                        : "Shared"}{" "}
                    · {draft.owned ? "Your draft" : "Shared with you"} ·{" "}
                    {relativeTime(draft.updatedAt)}
                  </p>
                </Link>
              ))
            ) : (
              <p className="home-empty">Your next idea starts with a draft.</p>
            )}
          </div>
          <div className="draft-pagination">
            <button
              type="button"
              disabled={!offset}
              onClick={() => setOffset((value) => Math.max(0, value - 24))}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!query.data.hasMore}
              onClick={() => setOffset((value) => value + 24)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
