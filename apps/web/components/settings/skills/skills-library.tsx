"use client";
// Frozen saves survive uncertainty; library edits never activate inference.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  BookOpenIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { LibrarySchema, HistorySchema, SaveSchema, type SkillLibrary, type SkillPending, type SkillProvenance } from "@/lib/skills/contracts";
import { SkillRequestError, skillRequest, sendSkillChange } from "@/lib/skills/client";
import { SkillEditor, EMPTY_SKILL } from "./skill-editor";
import "./skills.css";
type RecordRow = SkillLibrary["skills"][number];
function provenance(row: RecordRow): SkillProvenance {
  const { document, source, sourceUrl, versionLabel, licenseNotes } =
    row.version;
  return { document, source, sourceUrl, versionLabel, licenseNotes };
}
export function SkillsLibrary(): React.JSX.Element {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["skills-library"],
    queryFn: ({ signal }) =>
      skillRequest("/api/skills", LibrarySchema, { signal }),
    retry: false,
  });
  const [selected, setSelected] = useState<RecordRow | null>(null),
    [draft, setDraft] = useState<SkillProvenance>(EMPTY_SKILL),
    [baseline, setBaseline] = useState(JSON.stringify(EMPTY_SKILL));
  const [search, setSearch] = useState(""),
    [pending, setPending] = useState<SkillPending | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [conflict, setConflict] = useState(false);
  const [next, setNext] = useState<{ id: string | null } | null>(null),
    [leave, setLeave] = useState<string | null>(null),
    [archiveConfirm, setArchiveConfirm] = useState(false);
  const leaving = useRef(false);
  const gate = useRef(false),
    editor = useRef<HTMLElement>(null);
  const dirty = baseline !== JSON.stringify(draft);
  const history = useQuery({
    queryKey: ["skill-history", selected?.skill.id],
    queryFn: ({ signal }) =>
      skillRequest(`/api/skills/${selected!.skill.id}`, HistorySchema, {
        signal,
      }),
    enabled: Boolean(selected),
    retry: false,
  });
  useEffect(() => {
    if (!dirty && !pending) return;
    const unload = (event: BeforeUnloadEvent): void => {
      if (!leaving.current) event.preventDefault();
    };
    const click = (event: MouseEvent): void => {
      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        event.defaultPrevented ||
        !anchor ||
        anchor.target === "_blank" ||
        event.ctrlKey ||
        event.metaKey ||
        anchor.href.startsWith(`${location.href.split("#")[0]}#`)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setLeave(anchor.href);
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, pending]);
  const adopt = (row: RecordRow | null): void => {
    const value = row ? provenance(row) : { ...EMPTY_SKILL };
    setSelected(row);
    setDraft(value);
    setBaseline(JSON.stringify(value));
    setConflict(false);
    setError("");
    setNotice("");
  };
  const choose = (row: RecordRow | null): void => {
    if (pending || busy || gate.current) return;
    if (dirty) setNext({ id: row?.skill.id ?? null });
    else adopt(row);
  };
  const finish = async (ack: {
    savedRevision: string;
    currentRevision: string;
    skillId: string;
  }): Promise<void> => {
    setPending(null);
    const fresh = await query.refetch();
    void client.invalidateQueries({ queryKey: ["skill-history", ack.skillId] });
    const row = fresh.data?.skills.find(
      (item) => item.skill.id === ack.skillId,
    );
    if (
      row &&
      row.skill.revision === ack.savedRevision &&
      ack.currentRevision === ack.savedRevision
    ) {
      adopt(row);
      setNotice(
        "Saved on this instance. Choose this version in project settings to apply it to future requests.",
      );
    } else {
      setConflict(true);
      setNotice(
        "The save was confirmed, but a newer change exists or the library could not be refreshed. Your draft is retained; reload and compare.",
      );
    }
  };
  const send = async (
    change: SkillPending,
    recovering = false,
  ): Promise<void> => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    try {
      await finish(await sendSkillChange(change));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "This save could not be confirmed.",
      );
      if (
        !recovering &&
        failure instanceof SkillRequestError &&
        failure.status >= 400 &&
        failure.status < 500
      ) {
        setPending(null);
        setConflict(failure.status === 409);
      }
    } finally {
      gate.current = false;
      setBusy(false);
    }
  };
  const save = (): void => {
    if (pending || busy || gate.current || conflict) return;
    const skillId = selected?.skill.id ?? crypto.randomUUID(),
      requestId = crypto.randomUUID();
    const change: SkillPending = {
      skillId,
      requestId,
      path: selected ? `/api/skills/${skillId}` : "/api/skills",
      method: selected ? "PATCH" : "POST",
      body: selected
        ? {
            kind: "content",
            requestId,
            expectedRevision: selected.skill.revision,
            ...draft,
          }
        : { skillId, requestId, ...draft },
    };
    setPending(change);
    void send(change);
  };
  const check = async (): Promise<void> => {
    if (!pending || gate.current) return;
    gate.current = true;
    setBusy(true);
    try {
      const ack = await skillRequest(
        `/api/skills/${pending.skillId}/actions/${pending.requestId}`,
        SaveSchema.nullable(),
      );
      if (ack) await finish(ack);
      else
        setError(
          "No acknowledgement is recorded yet. Retry the same frozen save to resolve it safely; a missing response is not a confirmed failure.",
        );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The saved change could not be checked.",
      );
    } finally {
      gate.current = false;
      setBusy(false);
    }
  };
  const rows =
    query.data?.skills.filter((row) =>
      `${row.version.name} ${row.version.description}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  if (
    query.error instanceof SkillRequestError &&
    [401, 403].includes(query.error.status)
  )
    return (
      <p role="alert">Your access changed. Sign in again to open Skills.</p>
    );
  return (
    <div className="skills-page">
      <header className="settings-page-heading">
        <p>Your settings / Guidance</p>
        <h1>Skills</h1>
        <span>
          Give your projects a consistent way of working. Write instructions
          once, review each version and choose where to use it.
        </span>
      </header>
      <section className="skills-intro">
        <span className="skills-intro-mark">
          <SparklesIcon size={22} aria-hidden="true" />
        </span>
        <div>
          <h2>Your knowledge, reusable.</h2>
          <p>
            Skills guide the model. They never grant tools or permissions. Beta
            supports one self-contained SKILL.md, without scripts or bundled
            files.
          </p>
        </div>
        <a
          href="https://agentskills.io/specification"
          target="_blank"
          rel="noreferrer"
        >
          Format guide ↗ <span className="sr-only">External site</span>
        </a>
      </section>
      {query.isPending && <p role="status">Loading your library…</p>}
      {query.isError && (
        <div role="alert" className="skill-feedback">
          Your library could not be refreshed. Saved data may be stale.{" "}
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      )}
      <div className="skills-layout">
        <section className="skill-collection" aria-label="My skills">
          <div className="skill-collection-heading">
            <h2>
              My skills <span>{query.data?.skills.length ?? 0}</span>
            </h2>
            <Button
              aria-label="Create a skill"
              size="icon"
              variant="outline"
              disabled={Boolean(pending) || busy}
              onClick={() => choose(null)}
            >
              <PlusIcon size={16} />
            </Button>
          </div>
          <label className="skill-search">
            <SearchIcon size={15} aria-hidden="true" />
            <Input
              aria-label="Search skills"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search your library"
            />
          </label>
          <div className="skill-collection-list">
            {rows.map((row) => (
              <button
                className="skill-library-row"
                aria-pressed={selected?.skill.id === row.skill.id}
                disabled={Boolean(pending) || busy}
                key={row.skill.id}
                onClick={() => choose(row)}
              >
                <BookOpenIcon size={17} aria-hidden="true" />
                <span>
                  <strong>{row.version.name}</strong>
                  <small>{row.version.description}</small>
                  <em>
                    {row.skill.archivedAt
                      ? "Archived"
                      : row.version.versionLabel
                        ? `Version ${row.version.versionLabel}`
                        : "Saved version"}
                  </em>
                </span>
              </button>
            ))}
            {!query.isPending && rows.length === 0 && (
              <p className="skill-empty">
                {search
                  ? "No matching skills."
                  : "Your library starts here. Create instructions or import a reviewed SKILL.md."}
              </p>
            )}
          </div>
          <p className="skill-collection-note">
            Private to your account. Selected project versions are shared with
            that project's members.
          </p>
          <p className="skill-collection-note">
            <a
              href="https://github.com/anthropics/skills"
              target="_blank"
              rel="noreferrer"
            >
              Browse example skills ↗{" "}
              <span className="sr-only">External site</span>
            </a>
            <br />
            Review each skill's license and dependencies. Import self-contained
            instructions manually; scripts and bundled files are unsupported.
          </p>
        </section>
        <section
          className="skill-edit-panel"
          ref={editor}
          aria-label="Skill editor"
        >
          <header>
            <div>
              <p className="home-eyebrow">
                {selected
                  ? selected.skill.archivedAt
                    ? "Archived skill"
                    : "Versioned instructions"
                  : "New skill"}
              </p>
              <h2>
                {selected?.version.name ??
                  "A little expertise goes a long way."}
              </h2>
              <p>
                Save a version here, then select it in a project's settings.
                Saving never starts a build.
              </p>
            </div>
          </header>
          {(error || notice) && (
            <div className="skill-feedback" role={error ? "alert" : "status"}>
              {error || notice}
            </div>
          )}
          {pending && !busy && (
            <div className="skill-recovery">
              <p>
                This save is unconfirmed. Its text and change identifier are
                frozen.
              </p>
              <Button variant="outline" onClick={() => void check()}>
                Check saved change
              </Button>
              <Button
                variant="outline"
                onClick={() => void send(pending, true)}
              >
                Retry same save
              </Button>
            </div>
          )}
          {conflict && (
            <div className="skill-recovery">
              <p>
                Your draft is retained. Review the current saved version before
                replacing anything.
              </p>
              <Button
                variant="outline"
                onClick={async () => {
                  const fresh = await query.refetch();
                  const current = fresh.data?.skills.find(
                    (row) => row.skill.id === selected?.skill.id,
                  );
                  if (current) setNext({ id: current.skill.id });
                  else if (!fresh.error) setConflict(false);
                }}
              >
                Reload and compare
              </Button>
            </div>
          )}
          <SkillEditor
            value={draft}
            onChange={setDraft}
            onError={setError}
            disabled={
              busy || Boolean(pending) || Boolean(selected?.skill.archivedAt)
            }
          />
          <footer className="skill-edit-actions">
            <span>
              {selected?.skill.archivedAt
                ? "Restore before editing."
                : dirty
                  ? "Unsaved changes"
                  : "Ready to review"}
            </span>
            <div>
              {selected && (
                <Button
                  variant="outline"
                  disabled={busy || Boolean(pending) || dirty || conflict}
                  onClick={() => setArchiveConfirm(true)}
                >
                  <ArchiveIcon size={14} />
                  {selected.skill.archivedAt ? "Restore" : "Archive"}
                </Button>
              )}
              <Button
                disabled={
                  busy ||
                  Boolean(pending) ||
                  conflict ||
                  Boolean(selected?.skill.archivedAt) ||
                  !draft.document.trim() ||
                  new TextEncoder().encode(draft.document).length > 16 * 1024 ||
                  Boolean(selected && !dirty)
                }
                onClick={save}
              >
                {busy
                  ? "Checking…"
                  : selected
                    ? "Save new version"
                    : "Save skill"}
              </Button>
            </div>
          </footer>
          {selected && (
            <details className="skill-history">
              <summary>Saved versions</summary>
              <p>
                Latest 50 immutable versions. Selecting one here reviews its
                text; it does not activate it.
              </p>
              {history.isError && (
                <Button
                  variant="outline"
                  onClick={() => void history.refetch()}
                >
                  Retry version history
                </Button>
              )}
              {history.data?.versions.map((version) => (
                <details key={version.id}>
                  <summary>
                    {version.versionLabel ?? version.createdAt.slice(0, 10)} ·{" "}
                    {version.id.slice(0, 8)}
                    {version.id === selected.skill.currentVersionId
                      ? " · Current"
                      : ""}
                  </summary>
                  <p>
                    {version.source} · SHA-256 {version.sha256}
                  </p>
                  {version.sourceUrl && <p>Source: {version.sourceUrl}</p>}
                  {version.licenseNotes && <p>{version.licenseNotes}</p>}
                  <pre>{version.document}</pre>
                </details>
              ))}
            </details>
          )}
        </section>
      </div>
      <Dialog
        open={Boolean(next) || Boolean(leave)}
        onOpenChange={(open) => {
          if (!open) {
            setNext(null);
            setLeave(null);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>
            {pending
              ? "Resolve the pending save first"
              : "Leave these unsaved instructions?"}
          </DialogTitle>
          <DialogDescription>
            {pending
              ? "Check the saved change or retry the same frozen request before navigating away."
              : "Your current draft will be discarded. Saved versions remain unchanged."}
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setNext(null);
                setLeave(null);
              }}
            >
              Keep editing
            </Button>
            {!pending && (
              <Button
                onClick={() => {
                  if (leave) {
                    leaving.current = true;
                    location.assign(leave);
                  } else {
                    adopt(
                      query.data?.skills.find(
                        (row) => row.skill.id === next?.id,
                      ) ?? null,
                    );
                    setNext(null);
                  }
                }}
              >
                Discard draft and continue
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={archiveConfirm} onOpenChange={setArchiveConfirm}>
        <DialogContent>
          <DialogTitle>
            {selected?.skill.archivedAt
              ? "Restore this skill?"
              : "Archive this skill?"}
          </DialogTitle>
          <DialogDescription>
            Historical versions stay intact. An archived skill blocks new
            requests in projects that still select it until the project owner
            reviews that selection.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveConfirm(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!selected || gate.current || pending || busy) return;
                const requestId = crypto.randomUUID();
                const change: SkillPending = {
                  requestId,
                  skillId: selected.skill.id,
                  path: `/api/skills/${selected.skill.id}`,
                  method: "PATCH",
                  body: {
                    kind: "archive",
                    requestId,
                    expectedRevision: selected.skill.revision,
                    archived: !selected.skill.archivedAt,
                  },
                };
                setArchiveConfirm(false);
                setPending(change);
                void send(change);
              }}
            >
              {selected?.skill.archivedAt ? "Restore skill" : "Archive skill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
