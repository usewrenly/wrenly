"use client";
// Only server-confirmed metadata is saved; ambiguous requests keep their frozen snapshot.
import { ProjectSkills } from "./project-skills";
import { ProjectArchiveControls } from "./project-archive-controls";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowLeftIcon, CopyIcon, Settings2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { stackLabel } from "@/lib/stacks";
import {
  requestProjectSettings,
  SettingsRequestError,
  type ProjectDetails,
  type SettingsChange,
} from "@/lib/projects/settings/project-settings";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
export function ProjectSettings({
  projectId,
  accessLabel,
  combined = false,
  section = "general",
  onSectionChange,
  archiveBlocked = false,
}: {
  projectId: string;
  accessLabel?: string;
  combined?: boolean;
  archiveBlocked?: boolean;
  section?: "general" | "collaboration";
  onSectionChange?: (section: "general" | "collaboration") => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["project-settings", projectId],
    queryFn: ({ signal }) =>
      requestProjectSettings(projectId, undefined, signal),
    retry: false,
    staleTime: 0,
  });
  const [skillsBlocked, setSkillsBlocked] = useState(false);
  const [baseline, setBaseline] = useState<ProjectDetails | null>(null),
    [name, setName] = useState(""),
    [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [conflict, setConflict] = useState<ProjectDetails | null>(null),
    [leave, setLeave] = useState(false),
    [copyStatus, setCopyStatus] = useState("");
  const submitting = useRef(false),
    frozen = useRef<SettingsChange | null>(null),
    feedback = useRef<HTMLDivElement>(null);
  const desiredDescription = description.trim() ? description : null;
  const dirty = Boolean(
    baseline &&
    (name.trim() !== baseline.name ||
      description !== (baseline.description ?? "")),
  );
  const valid =
    name.trim().length > 0 &&
    name.trim().length <= 100 &&
    description.length <= 500;
  const adopt = (details: ProjectDetails): void => {
    setBaseline(details);
    setName(details.name);
    setDescription(details.description ?? "");
    setConflict(null);
    setUncertain(false);
    frozen.current = null;
  };
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    void queryClient.invalidateQueries({
      queryKey: ["project-settings", projectId],
    });
  };
  useEffect(() => {
    if (query.data && !baseline) {
      setBaseline(query.data);
      setName(query.data.name);
      setDescription(query.data.description ?? "");
    }
  }, [query.data, baseline]);
  useEffect(() => {
    if (error) feedback.current?.focus();
  }, [error]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const save = async (retry = false): Promise<void> => {
    if (
      submitting.current ||
      !baseline ||
      !valid ||
      conflict ||
      (!retry && !dirty)
    )
      return;
    const change = retry
      ? frozen.current
      : {
          name: name.trim(),
          description: desiredDescription,
          expected: { name: baseline.name, description: baseline.description },
        };
    if (!change) return;
    frozen.current = change;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const details = await requestProjectSettings(projectId, change);
      adopt(details);
      invalidate();
      setNotice("Project details saved.");
    } catch (failure) {
      if (
        failure instanceof SettingsRequestError &&
        failure.status === 409 &&
        failure.current
      ) {
        setConflict(failure.current);
        setUncertain(false);
      } else
        setUncertain(
          !(failure instanceof SettingsRequestError) ||
            failure.status >= 500 ||
            failure.status === 408,
        );
      setError(
        failure instanceof Error
          ? failure.message
          : "Save could not be confirmed.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const check = async (): Promise<void> => {
    if (submitting.current || !frozen.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const details = await requestProjectSettings(projectId),
        change = frozen.current;
      if (
        details.name === change.name &&
        details.description === change.description
      ) {
        adopt(details);
        invalidate();
        setNotice("Project details saved.");
      } else if (
        details.name === change.expected.name &&
        details.description === change.expected.description
      ) {
        setBaseline(details);
        setUncertain(false);
        setNotice(
          "The saved details still match your starting point. Review and save your draft when ready.",
        );
      } else {
        setConflict(details);
        setUncertain(false);
        setError("Saved details changed. Review them before saving again.");
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Saved details could not be checked.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(projectId);
      setCopyStatus("Project ID copied.");
    } catch {
      setCopyStatus("Copy was unavailable. Select and copy the ID manually.");
    }
  };
  if (!baseline)
    return (
      <div className="project-settings-page">
        <Link href={`/p/${projectId}`}>← Back to workspace</Link>
        {query.isPending ? (
          <p role="status">Loading project settings…</p>
        ) : (
          <div role="alert">
            <p>{query.error?.message ?? "Project settings are unavailable."}</p>
            {query.error instanceof SettingsRequestError &&
            query.error.status === 401 ? (
              <Link href="/sign-in">Sign in again</Link>
            ) : (
              <button type="button" onClick={() => void query.refetch()}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    );
  return (
    <div className="project-settings-page">
      <button
        type="button"
        className="project-settings-back"
        disabled={busy}
        onClick={() => {
          if (dirty) setLeave(true);
          else window.location.assign(`/p/${projectId}`);
        }}
      >
        <ArrowLeftIcon size={14} aria-hidden="true" /> Back to workspace
      </button>
      <header className="project-settings-heading">
        <p className="home-eyebrow">{baseline.name} / Settings</p>
        <h1>Project settings</h1>
        <p>
          Manage project details, access and the model your collaborators use.
        </p>
        {combined && (
          <nav
            className="project-settings-jump"
            aria-label="Project settings sections"
          >
            {(["general", "collaboration"] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={section === item}
                onClick={() => onSectionChange?.(item)}
              >
                {item === "general" ? "General" : "Collaboration"}
              </button>
            ))}
          </nav>
        )}
      </header>
      <div hidden={combined && section !== "general"}>
        {error && (
          <div
            ref={feedback}
            tabIndex={-1}
            role="alert"
            className="project-settings-notice"
          >
            <p>{error}</p>
            {uncertain && (
              <p>
                Your draft is preserved. Check saved details or retry the same
                save before making another change.
              </p>
            )}
          </div>
        )}
        {notice && (
          <p role="status" className="project-settings-notice">
            {notice}
          </p>
        )}
        {uncertain && (
          <div className="project-settings-actions">
            <button type="button" disabled={busy} onClick={() => void check()}>
              Check saved details
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(true)}
            >
              Retry same save
            </button>
          </div>
        )}
        {conflict && (
          <section
            className="project-settings-conflict"
            aria-label="Review changed project details"
          >
            <h2>Saved details changed elsewhere</h2>
            <p>Your draft remains in the form below.</p>
            <dl>
              <dt>Saved name</dt>
              <dd>{conflict.name}</dd>
              <dt>Saved description</dt>
              <dd>{conflict.description ?? "No description"}</dd>
            </dl>
            <div className="project-settings-actions">
              <button
                type="button"
                onClick={() => {
                  setBaseline(conflict);
                  setConflict(null);
                  setError("");
                  setNotice(
                    "Saved details reviewed. Review your draft and save deliberately to apply it.",
                  );
                }}
              >
                Keep editing my draft
              </button>
              <button
                type="button"
                onClick={() => {
                  adopt(conflict);
                  setError("");
                  setNotice("Current saved details loaded.");
                }}
              >
                Use saved details
              </button>
            </div>
          </section>
        )}
        <div className="project-settings-grid">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <section id="project-general" className="project-settings-section">
              <h2>
                <Settings2Icon size={16} aria-hidden="true" /> General
              </h2>
              <label htmlFor="project-name">Project name</label>
              <input
                id="project-name"
                value={name}
                maxLength={100}
                required
                disabled={busy || uncertain}
                onChange={(event) => {
                  setName(event.target.value);
                  setNotice("");
                }}
              />
              <label htmlFor="project-description">
                Description <span>Optional</span>
              </label>
              <textarea
                id="project-description"
                rows={5}
                value={description}
                maxLength={500}
                disabled={busy || uncertain}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setNotice("");
                }}
              />
              <p className="project-settings-count">
                {description.length}/500 characters
              </p>
              <div className="project-settings-actions">
                <button
                  type="submit"
                  disabled={
                    busy || uncertain || Boolean(conflict) || !dirty || !valid
                  }
                  className="project-settings-save"
                >
                  {busy ? "Confirming…" : "Save changes"}
                </button>
                <span>{dirty ? "Unsaved changes" : "Up to date"}</span>
              </div>
            </section>
          </form>
          <aside className="project-settings-section">
            <h2>Project details</h2>
            <dl>
              <dt>Framework</dt>
              <dd>{stackLabel(baseline.stack)}</dd>
              <dt>Project access</dt>
              <dd>{accessLabel ?? "Managed in Collaboration"}</dd>
              <dt>Project ID</dt>
              <dd className="project-settings-id">{baseline.id}</dd>
              <dt>Created</dt>
              <dd>{new Date(baseline.createdAt).toLocaleDateString()}</dd>
              <dt>Last updated</dt>
              <dd>{new Date(baseline.updatedAt).toLocaleString()}</dd>
            </dl>
            <button type="button" onClick={() => void copy()}>
              <CopyIcon size={14} aria-hidden="true" /> Copy project ID
            </button>
            {copyStatus && <p role="status">{copyStatus}</p>}
            <p>
              Sharing is managed explicitly for this project. Its framework
              stays fixed so its revisions and build history remain consistent.
            </p>
          </aside>
        </div>
        <ProjectSkills projectId={projectId} onPendingChange={setSkillsBlocked} />
        <ProjectArchiveControls
          projectId={projectId}
          blockedByDraft={
            archiveBlocked || skillsBlocked || dirty || busy || uncertain || Boolean(conflict)
          }
        />
      </div>
      <Dialog open={leave} onOpenChange={setLeave}>
        <DialogContent>
          <DialogTitle>Leave without saving?</DialogTitle>
          <DialogDescription>
            Your draft has unsaved project details.
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setLeave(false)}
            >
              Keep editing
            </Button>
            <Button
              className="min-h-11"
              render={<Link href={`/p/${projectId}`} />}
            >
              Discard changes and leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
