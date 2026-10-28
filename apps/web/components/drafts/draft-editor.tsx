"use client";
// Conflict review and exact retries preserve text and authority.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChoiceSelect } from "@/components/ui/choice-select";
import {
  draftRequest,
  draftObject,
  DraftRequestError,
  parseDraft,
  type ProjectDraft,
} from "@/lib/projects/drafts/project-drafts";
import { relativeTime } from "@/lib/format";
// Poll without replacing unsaved text; debounce member searches to limit requests.
const DRAFT_POLL_INTERVAL_MS = 5_000;
const MEMBER_SEARCH_DELAY_MS = 300;

type Role = "viewer" | "editor";
/** Saved ideas remain separate from executable projects; Use as prompt only opens a reviewed handoff. */
export function DraftEditor({ id }: { id: string }): React.JSX.Element {
  const [baseline, setBaseline] = useState<ProjectDraft | null>(null),
    [current, setCurrent] = useState<ProjectDraft | null>(null);
  const [title, setTitle] = useState(""),
    [text, setText] = useState(""),
    [mode, setMode] = useState<ProjectDraft["accessMode"]>("private"),
    [instanceRole, setInstanceRole] = useState<Role>("viewer"),
    [selected, setSelected] = useState<Record<string, Role>>({});
  const [people, setPeople] = useState<Array<{ userId: string; name: string }>>(
      [],
    ),
    [directoryError, setDirectoryError] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [review, setReview] = useState(false),
    [unavailable, setUnavailable] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const directoryEpoch = useRef(0);
  const frozen = useRef<Record<string, unknown> | null>(null),
    lock = useRef(false),
    abort = useRef<AbortController | null>(null),
    initial = useRef(false),
    epoch = useRef(0);
  const contentDirty = Boolean(
    baseline && (title.trim() !== baseline.title || text !== baseline.body),
  );
  const normalized = (rows: Record<string, Role>): string =>
    JSON.stringify(Object.entries(rows).sort(([a], [b]) => a.localeCompare(b)));
  const shareDirty = Boolean(
    baseline &&
    (mode !== baseline.accessMode ||
      instanceRole !== baseline.instanceRole ||
      (mode === "selected" &&
        normalized(selected) !==
          normalized(
            Object.fromEntries(
              baseline.members.map((person) => [person.userId, person.role]),
            ),
          ))),
  );
  const changedElsewhere = Boolean(
    current && baseline && current.revision !== baseline.revision,
  );
  const editable = Boolean(
    current?.capabilities.contribute && !current.archivedAt,
  );
  const blocked = busy || uncertain || changedElsewhere || unavailable;
  const adopt = (
    value: ProjectDraft,
    keepText = false,
    keepSharing = false,
  ): void => {
    setBaseline(value);
    setCurrent(value);
    if (!keepText) {
      setTitle(value.title);
      setText(value.body);
    }
    if (!keepSharing) {
      setMode(value.accessMode);
      setInstanceRole(value.instanceRole);
      setSelected(
        Object.fromEntries(
          value.members.map((person) => [person.userId, person.role]),
        ),
      );
    }
    setReview(false);
  };
  const loadPeople = async (signal: AbortSignal): Promise<void> => {
    const observed = ++directoryEpoch.current;
    try {
      const result = await draftRequest(
        `/api/drafts/${id}/members?search=${encodeURIComponent(memberSearch)}`,
        undefined,
        signal,
      );
      if (!Array.isArray(result.members))
        throw new Error("Members unavailable.");
      const members = result.members.map((value) => {
        const row = draftObject(value);
        if (typeof row.userId !== "string" || typeof row.name !== "string")
          throw new Error("Members unavailable.");
        return { userId: row.userId, name: row.name };
      });
      if (!signal.aborted && observed === directoryEpoch.current) {
        setPeople((previous) => [
          ...members,
          ...previous.filter((person) => Boolean(selected[person.userId])),
        ]);
        setDirectoryError("");
      }
    } catch {
      if (!signal.aborted && observed === directoryEpoch.current)
        setDirectoryError(
          "Member choices could not be loaded. Retry before changing sharing.",
        );
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      const observed = epoch.current;
      try {
        const result = parseDraft(
          (
            await draftRequest(
              `/api/drafts/${id}`,
              undefined,
              controller.signal,
            )
          ).draft,
          id,
        );
        if (
          controller.signal.aborted ||
          observed !== epoch.current ||
          lock.current
        )
          return;
        setCurrent(result);
        setUnavailable(false);
        if (!initial.current) {
          initial.current = true;
          adopt(result);
        }
      } catch (failure) {
        if (controller.signal.aborted || observed !== epoch.current) return;
        setError(
          failure instanceof Error
            ? failure.message
            : "Draft could not be loaded.",
        );
        if (
          failure instanceof DraftRequestError &&
          [401, 403, 404].includes(failure.status)
        ) {
          setUnavailable(true);
          setCurrent(null);
          setPeople([]);
        }
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void poll(), DRAFT_POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // The route keys this editor by ID; polling must not reset an unsaved draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (!current?.capabilities.manage) return;
    const controller = new AbortController();
    const timer = setTimeout(() => void loadPeople(controller.signal), MEMBER_SEARCH_DELAY_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
      directoryEpoch.current++;
    };
    // Search is bounded; old responses cannot replace newer member choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, current?.capabilities.manage, memberSearch]);
  useEffect(() => {
    if (!contentDirty && !shareDirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [contentDirty, shareDirty]);
  const save = async (
    kind: "content" | "sharing" | "archive",
    archived = false,
  ): Promise<void> => {
    if (
      !baseline ||
      !current ||
      lock.current ||
      unavailable ||
      (changedElsewhere && !uncertain)
    )
      return;
    const input = frozen.current ?? {
      kind,
      requestId: crypto.randomUUID(),
      expectedRevision: baseline.revision,
      ...(kind === "content"
        ? { title: title.trim(), body: text }
        : kind === "sharing"
          ? {
              mode,
              instanceRole,
              members:
                mode === "selected"
                  ? Object.entries(selected)
                      .map(([userId, role]) => ({ userId, role }))
                      .sort((a, b) => a.userId.localeCompare(b.userId))
                  : [],
            }
          : { archived }),
    };
    frozen.current = input;
    lock.current = true;
    epoch.current++;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await draftRequest(
          `/api/drafts/${id}`,
          input,
          abort.current?.signal,
        ),
        next = parseDraft(result.draft, id);
      frozen.current = null;
      setUncertain(false);
      if (result.savedRevision !== next.revision) {
        setCurrent(next);
        setNotice(
          "Your earlier change was confirmed, but newer changes exist. Review them before saving again.",
        );
      } else {
        adopt(
          next,
          input.kind !== "content" && contentDirty,
          input.kind !== "sharing" && shareDirty,
        );
        setNotice("Draft saved.");
      }
    } catch (failure) {
      const unknown =
        !(failure instanceof DraftRequestError) ||
        failure.status >= 500 ||
        failure.status === 408;
      setUncertain(unknown);
      if (!unknown) frozen.current = null;
      setError(
        failure instanceof Error
          ? failure.message
          : "Save could not be confirmed.",
      );
      if (
        failure instanceof DraftRequestError &&
        [401, 403, 404].includes(failure.status)
      ) {
        setUnavailable(true);
        setCurrent(null);
        setPeople([]);
      }
      if (failure instanceof DraftRequestError && failure.status === 409) {
        try {
          const next = parseDraft(
            (
              await draftRequest(
                `/api/drafts/${id}`,
                undefined,
                abort.current?.signal,
              )
            ).draft,
            id,
          );
          setCurrent(next);
          setReview(true);
        } catch {
          setNotice(
            "Saved draft could not be refreshed. Your text is preserved.",
          );
        }
      }
    } finally {
      epoch.current++;
      lock.current = false;
      setBusy(false);
    }
  };
  if (unavailable || !baseline || !current)
    return (
      <div className="projects-page">
        <Link href="/projects/drafts">← Drafts</Link>
        {error ? (
          <p role="alert" className="settings-notice">
            {error}
          </p>
        ) : (
          <p role="status">Loading draft…</p>
        )}
      </div>
    );
  return (
    <div className="projects-page draft-editor">
      <Link href="/projects/drafts" className="project-settings-back">
        ← All drafts
      </Link>
      <header className="projects-heading">
        <div>
          <p className="home-eyebrow">An idea, taking shape</p>
          <h1>{current.title}</h1>
          <p>
            {current.archivedAt
              ? "Archived"
              : current.accessMode === "private"
                ? "Private"
                : "Shared"}{" "}
            · Last saved by {current.updatedByName} ·{" "}
            {relativeTime(current.updatedAt)}
          </p>
        </div>
        {!current.archivedAt && (
          <Link
            className="projects-new"
            href={`/?draft=${id}&revision=${current.revision}#new-project`}
          >
            Use saved draft as prompt ↗
          </Link>
        )}
      </header>
      <p className="draft-explanation">
        This is a saved idea, not a build. Use as prompt lets you review it and
        choose how to build. Sharing text does not start a model request.
      </p>
      {error && (
        <p role="alert" className="settings-notice">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="settings-notice">
          {notice}
        </p>
      )}
      {uncertain && (
        <div className="draft-actions">
          <p>The result is unconfirmed. Your original request is preserved.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void save(
                frozen.current?.kind as "content" | "sharing" | "archive",
              )
            }
          >
            Retry same save
          </button>
        </div>
      )}
      {changedElsewhere && !uncertain && (
        <section className="draft-conflict">
          <h2>Saved draft changed</h2>
          <p>
            Your unsaved text is preserved. Review the latest version before
            saving.
          </p>
          <button type="button" onClick={() => setReview((value) => !value)}>
            {review ? "Hide saved text" : "Review saved text"}
          </button>
          {review && (
            <>
              <h3>{current.title}</h3>
              <pre>{current.body || "No text yet."}</pre>
              <div className="draft-actions">
                <button
                  type="button"
                  onClick={() => {
                    adopt(current);
                    setError("");
                  }}
                >
                  Use saved version
                </button>
                <button
                  type="button"
                  onClick={() => {
                    adopt(current, true, true);
                    setError("");
                    setNotice(
                      "Latest version reviewed. Save deliberately to apply your text.",
                    );
                  }}
                >
                  Keep my draft
                </button>
              </div>
            </>
          )}
        </section>
      )}
      <section className="settings-section">
        <h2>Your idea</h2>
        {editable ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save("content");
            }}
          >
            <label htmlFor="idea-name">Name</label>
            <input
              id="idea-name"
              required
              maxLength={100}
              value={title}
              disabled={busy || uncertain}
              onChange={(event) => setTitle(event.target.value)}
            />
            <label htmlFor="idea-text">Notes</label>
            <textarea
              id="idea-text"
              maxLength={50000}
              value={text}
              disabled={busy || uncertain}
              onChange={(event) => setText(event.target.value)}
              placeholder="The rough idea, the people it helps, what it could become…"
            />
            <p className="settings-field-help">
              {text.length.toLocaleString()}/50,000 characters · Saves are
              explicit.
            </p>
            <button
              className="settings-primary"
              type="submit"
              disabled={blocked || !contentDirty || !title.trim()}
            >
              {" "}
              {busy ? "Confirming…" : "Save draft"}
            </button>
          </form>
        ) : (
          <>
            <p>
              {current.capabilities.role === "viewer"
                ? "You have Viewer access."
                : "Restore this draft to edit it."}
            </p>
            <pre className="draft-readonly">
              {current.body || "No notes yet."}
            </pre>
          </>
        )}
      </section>
      {current.capabilities.manage && (
        <section className="settings-section">
          <h2>Sharing</h2>
          <p>
            Choose which accepted instance members can view or edit this idea.
          </p>
          <fieldset disabled={blocked || Boolean(current.archivedAt)}>
            <ChoiceSelect
              label="Draft visibility"
              value={mode}
              onChange={(value) => setMode(value as ProjectDraft["accessMode"])}
              options={[
                { value: "private", label: "Private · only you" },
                { value: "selected", label: "Selected members" },
                { value: "instance", label: "Everyone in this instance" },
              ]}
            />
            {mode === "instance" && (
              <ChoiceSelect
                label="Everyone’s draft role"
                value={instanceRole}
                onChange={(value) => setInstanceRole(value as Role)}
                options={[
                  { value: "viewer", label: "Viewer" },
                  { value: "editor", label: "Editor" },
                ]}
              />
            )}{" "}
            {mode === "selected" && (
              <>
                <label className="draft-member-search">
                  Find a member
                  <input
                    type="search"
                    value={memberSearch}
                    maxLength={100}
                    onChange={(event) => setMemberSearch(event.target.value)}
                    placeholder="Search accepted members…"
                  />
                </label>
                <p className="settings-field-help">
                  Future invitations do not grant access until accepted. Up to
                  100 members.
                </p>
                {directoryError && (
                  <p role="alert">
                    {directoryError}
                    <button
                      type="button"
                      onClick={() => {
                        if (abort.current)
                          void loadPeople(abort.current.signal);
                      }}
                    >
                      Retry members
                    </button>
                  </p>
                )}
                {[
                  ...new Map(
                    [...people, ...baseline.members].map((person) => [
                      person.userId,
                      person,
                    ]),
                  ).values(),
                ].map((person) => (
                  <div className="draft-person" key={person.userId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={Boolean(selected[person.userId])}
                        onChange={(event) =>
                          setSelected((previous) => {
                            const next = { ...previous };
                            if (event.target.checked)
                              next[person.userId] = "viewer";
                            else delete next[person.userId];
                            return next;
                          })
                        }
                      />
                      {person.name}
                    </label>
                    {selected[person.userId] && (
                      <ChoiceSelect
                        label={`Draft role for ${person.name}`}
                        value={selected[person.userId] ?? "viewer"}
                        onChange={(value) =>
                          setSelected((previous) => ({
                            ...previous,
                            [person.userId]: value as Role,
                          }))
                        }
                        options={[
                          { value: "viewer", label: "Viewer" },
                          { value: "editor", label: "Editor" },
                        ]}
                      />
                    )}
                  </div>
                ))}
              </>
            )}
            <button
              type="button"
              className="settings-primary"
              disabled={
                !shareDirty || (mode === "selected" && Boolean(directoryError))
              }
              onClick={() => void save("sharing")}
            >
              Save sharing
            </button>
          </fieldset>
        </section>
      )}
      {current.capabilities.manage && (
        <section className="settings-section">
          <h2>{current.archivedAt ? "Restore draft" : "Archive draft"}</h2>
          <p>
            Archiving preserves this idea and its sharing. Restore it to
            continue editing.
          </p>
          <button
            className="settings-sign-out"
            type="button"
            disabled={blocked || contentDirty || shareDirty}
            onClick={() => void save("archive", !current.archivedAt)}
          >
            {current.archivedAt ? "Restore draft" : "Archive draft"}
          </button>
          {(contentDirty || shareDirty) && (
            <p>Save or review your changes before archiving.</p>
          )}
        </section>
      )}
    </div>
  );
}
