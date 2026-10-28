"use client";
// Owner-reviewed version IDs; loading a selection never starts inference.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { z } from "zod";
import { BookOpenIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { LibrarySchema, ProjectSkillSchema, type ProjectSkillState } from "@/lib/skills/contracts";
import { SkillRequestError, skillRequest } from "@/lib/skills/client";
import "../../settings/skills/skills.css";
export function ProjectSkills({
  projectId,
  onPendingChange,
}: {
  projectId: string;
  onPendingChange?: (blocked: boolean) => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["project-skills", projectId],
    queryFn: ({ signal }) =>
      skillRequest(`/api/projects/${projectId}/skills`, ProjectSkillSchema, {
        signal,
      }),
    retry: false,
  });
  const library = useQuery({
    queryKey: ["skills-library"],
    queryFn: ({ signal }) =>
      skillRequest("/api/skills", LibrarySchema, { signal }),
    enabled: query.data?.canManage === true,
    retry: false,
  });
  const [base, setBase] = useState<ProjectSkillState | null>(null),
    [ids, setIds] = useState<string[]>([]),
    [pending, setPending] = useState<{
      requestId: string;
      expectedRevision: string;
      versionIds: string[];
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [conflict, setConflict] = useState(false);
  const gate = useRef(false),
    allowLeave = useRef(false);
  const [leave, setLeave] = useState<string | null>(null);
  const dirty = Boolean(
    base &&
    JSON.stringify(ids) !==
      JSON.stringify(base.selected.map((item) => item.versionId)),
  );
  useEffect(() => {
    if (
      query.data &&
      (!base ||
        (!dirty &&
          !pending &&
          !busy &&
          !conflict &&
          !query.isFetching &&
          query.data !== base))
    ) {
      setBase(query.data);
      setIds(query.data.selected.map((item) => item.versionId));
    }
  }, [base, query.data, dirty, pending, busy, conflict, query.isFetching]);
  useEffect(() => {
    onPendingChange?.(dirty || Boolean(pending) || busy || conflict);
    return () => onPendingChange?.(false);
  }, [dirty, pending, busy, conflict, onPendingChange]);
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (event: BeforeUnloadEvent): void => {
      if (!allowLeave.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);
  useEffect(() => {
    if (!dirty && !pending) return;
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
        event.metaKey
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setLeave(anchor.href);
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, [dirty, pending]);
  const adopt = (state: ProjectSkillState): void => {
    setBase(state);
    setIds(state.selected.map((item) => item.versionId));
    setConflict(false);
  };
  const send = async (
    body: NonNullable<typeof pending>,
    recovering = false,
  ): Promise<void> => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await skillRequest(
        `/api/projects/${projectId}/skills`,
        ProjectSkillSchema,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setPending(null);
      if (saved.savedRevision === saved.revision) {
        adopt(saved);
        setNotice(
          "Project skills saved. Future requests use these exact versions; existing work keeps its original guidance.",
        );
      } else {
        setConflict(true);
        setNotice(
          "The save was confirmed, but project settings changed again. Reload and compare your selection.",
        );
      }
      void client.invalidateQueries({
        queryKey: ["project-access", projectId],
      });
      void query.refetch();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "This selection could not be confirmed.",
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
  const check = async (): Promise<void> => {
    if (!pending || gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await skillRequest(
        `/api/projects/${projectId}/access/actions/${pending.requestId}`,
        z.object({
          action: z
            .object({
              savedRevision: z.string().uuid(),
              currentRevision: z.string().uuid(),
            })
            .nullable(),
        }),
      );
      if (!result.action) {
        setNotice(
          "No acknowledgement yet. Keep this selection and explicitly retry the same request when project access permits.",
        );
        return;
      }
      setPending(null);
      const fresh = await query.refetch();
      if (fresh.data && fresh.data.revision === result.action.savedRevision) {
        adopt(fresh.data);
        setNotice("The project skill selection was saved.");
      } else {
        setConflict(true);
        setNotice(
          "The selection was saved; newer project settings exist or could not be refreshed. Your choices are retained for review.",
        );
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "This selection could not be checked.",
      );
    } finally {
      gate.current = false;
      setBusy(false);
    }
  };
  if (query.isPending)
    return (
      <section className="project-settings-section project-skills">
        <p role="status">Loading project skills…</p>
      </section>
    );
  if (
    query.error instanceof SkillRequestError &&
    [401, 403, 404].includes(query.error.status)
  )
    return (
      <section className="project-settings-section project-skills">
        <p role="alert">
          Project skills are unavailable or your access changed.
        </p>
      </section>
    );
  return (
    <section
      className="project-settings-section project-skills"
      aria-label="Project skills"
    >
      <h2>
        <BookOpenIcon size={17} aria-hidden="true" />
        Project skills
      </h2>
      <p>
        Pin up to four reviewed instruction versions, shared with this project's
        members. These guide future conversations and builds; they never grant
        tools or network permissions.
      </p>
      {query.isError && (
        <p role="alert">
          Saved guidance could not be refreshed.{" "}
          <button onClick={() => void query.refetch()}>Try again</button>
        </p>
      )}
      {base?.selected.map((item) => (
        <details key={item.versionId}>
          <summary>
            {item.name} · {item.versionLabel ?? item.versionId.slice(0, 8)}
            {item.archived ? " · Archived: owner review required" : ""}
          </summary>
          <p className="settings-field-help">
            Pinned version {item.versionId} · SHA-256 {item.sha256}
          </p>
          {item.sourceUrl && (
            <p className="settings-field-help">Source: {item.sourceUrl}</p>
          )}
          {item.licenseNotes && (
            <p className="settings-field-help">{item.licenseNotes}</p>
          )}
          <pre className="project-skill-content">{item.document}</pre>
          {query.data?.canManage && ids.includes(item.versionId) && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || Boolean(pending)}
              onClick={() => setIds(ids.filter((id) => id !== item.versionId))}
            >
              Remove from selection
            </Button>
          )}
        </details>
      ))}
      {base && !base.selected.length && (
        <p className="skill-empty">No project skills selected.</p>
      )}
      {(error || notice) && (
        <p
          role={error ? "alert" : "status"}
          className="project-settings-notice"
        >
          {error || notice}
        </p>
      )}
      {pending && !busy && (
        <div className="project-skills-actions">
          <span>Unconfirmed selection; keep this frozen change.</span>
          <Button variant="outline" onClick={() => void check()}>
            Check saved selection
          </Button>
          <Button
            variant="outline"
            disabled={!query.data?.canManage}
            onClick={() => void send(pending, true)}
          >
            Check / retry same selection
          </Button>
        </div>
      )}
      {base && query.data?.canManage && (
        <>
          <div className="project-skills-actions">
            <Link href="/settings/skills">Manage your skill library ↗</Link>
            <span>{ids.length} / 4 selected</span>
          </div>
          {library.isPending && (
            <p role="status">Loading your available skills…</p>
          )}
          {library.isError && (
            <p role="alert">
              Your library could not be loaded.{" "}
              <button onClick={() => void library.refetch()}>Try again</button>
            </p>
          )}
          {library.data?.skills
            .filter((row) => !row.skill.archivedAt)
            .map((row) => {
              const pinned = base.selected.find(
                (item) => item.skillId === row.skill.id,
              );
              const versionId =
                pinned && ids.includes(pinned.versionId)
                  ? pinned.versionId
                  : row.version.id;
              const checked = ids.includes(versionId);
              return (
                <div key={row.skill.id} className="project-skill-choice">
                  <input
                    id={`project-skill-${row.skill.id}`}
                    type="checkbox"
                    checked={checked}
                    disabled={
                      busy ||
                      Boolean(pending) ||
                      (!checked && ids.length >= 4) ||
                      query.isError
                    }
                    onChange={(event) =>
                      setIds(
                        event.target.checked
                          ? [...ids, versionId]
                          : ids.filter((id) => id !== versionId),
                      )
                    }
                  />
                  <div>
                    <label htmlFor={`project-skill-${row.skill.id}`}>
                      <strong>{row.version.name}</strong>
                    </label>
                    <small>{row.version.description}</small>
                    <small>
                      {pinned && checked && pinned.versionId !== row.version.id
                        ? `Pinned older version ${pinned.versionId.slice(0, 8)}; library edits have not replaced it.`
                        : `Version ${row.version.versionLabel ?? row.version.id.slice(0, 8)}`}
                    </small>
                    {pinned &&
                      checked &&
                      pinned.versionId !== row.version.id && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || Boolean(pending)}
                          onClick={() =>
                            setIds(
                              ids.map((id) =>
                                id === pinned.versionId ? row.version.id : id,
                              ),
                            )
                          }
                        >
                          Select latest saved version
                        </Button>
                      )}
                  </div>
                </div>
              );
            })}
          <p className="settings-field-help">
            New selection order follows your choices. Library edits never
            automatically replace a pinned version. Saving may require active
            project work to finish.
          </p>
          {conflict && !pending && (
            <div className="project-skills-actions">
              <p>
                Selection retained. Review saved guidance before applying a
                different change.
              </p>
              <Button
                variant="outline"
                onClick={async () => {
                  const fresh = await query.refetch();
                  if (fresh.data) {
                    setBase(fresh.data);
                    setConflict(false);
                    setNotice(
                      "Saved guidance refreshed above. Your proposed version IDs remain selected for comparison; save only after reviewing.",
                    );
                  }
                }}
              >
                Reload saved guidance
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (query.data) adopt(query.data);
                }}
              >
                Use saved selection
              </Button>
            </div>
          )}
          <div className="project-skills-actions">
            <Button
              disabled={
                !dirty ||
                busy ||
                Boolean(pending) ||
                conflict ||
                query.isError ||
                library.isError
              }
              onClick={() => {
                if (!base || gate.current || pending) return;
                const body = {
                  requestId: crypto.randomUUID(),
                  expectedRevision: base.revision,
                  versionIds: [...ids],
                };
                setPending(body);
                void send(body);
              }}
            >
              {busy ? "Saving…" : "Save project skills"}
            </Button>
            {dirty && !pending && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (query.data) adopt(query.data);
                }}
              >
                Discard selection changes
              </Button>
            )}
          </div>
        </>
      )}
      <Dialog
        open={Boolean(leave)}
        onOpenChange={(open) => {
          if (!open) setLeave(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {pending
              ? "Resolve the pending selection first"
              : "Leave unsaved skill choices?"}
          </DialogTitle>
          <DialogDescription>
            {pending
              ? "Check or retry the same selection before leaving; its outcome is unconfirmed."
              : "Saved project guidance stays unchanged. Your unsaved choices will be discarded."}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeave(null)}>
              Keep reviewing
            </Button>
            {!pending && (
              <Button
                onClick={() => {
                  if (leave) {
                    allowLeave.current = true;
                    location.assign(leave);
                  }
                }}
              >
                Discard and leave
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
