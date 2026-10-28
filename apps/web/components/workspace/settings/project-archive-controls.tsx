"use client";
// Archive/restore requires explicit confirmation and reviewed revision; it never removes remote resources.
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
interface State {
  archivedAt: string | null;
  revision: string;
  canManage: boolean;
  blockers: string[];
  savedRevision?: string;
}
function parse(value: unknown): State {
  if (
    !value ||
    typeof value !== "object" ||
    !("revision" in value) ||
    typeof value.revision !== "string" ||
    !("archivedAt" in value) ||
    !(value.archivedAt === null || typeof value.archivedAt === "string") ||
    !("canManage" in value) ||
    typeof value.canManage !== "boolean" ||
    !("blockers" in value) ||
    !Array.isArray(value.blockers) ||
    !value.blockers.every((item) => typeof item === "string")
  )
    throw new Error("Archive state could not be read.");
  return {
    revision: value.revision,
    archivedAt: value.archivedAt,
    canManage: value.canManage,
    blockers: value.blockers,
    ...("savedRevision" in value && typeof value.savedRevision === "string"
      ? { savedRevision: value.savedRevision }
      : {}),
  };
}
/** Reads current authority and blockers before review; only confirmed writes clear the original request. */
export function ProjectArchiveControls({
  projectId,
  blockedByDraft = false,
}: {
  projectId: string;
  blockedByDraft?: boolean;
}): React.JSX.Element {
  const cache = useQueryClient(),
    frozen = useRef<{
      requestId: string;
      expectedRevision: string;
      archived: boolean;
    } | null>(null),
    lock = useRef(false);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const query = useQuery({
    queryKey: ["project-archive", projectId],
    retry: false,
    refetchInterval: 5000,
    queryFn: async ({ signal }) => {
      const response = await apiFetch(`/api/projects/${projectId}/archive`, {
          signal,
          cache: "no-store",
        }),
        value: unknown = await response.json();
      if (!response.ok)
        throw new Error("Project archive state could not be loaded.");
      return parse(value);
    },
  });
  const save = async (): Promise<void> => {
    const input = frozen.current;
    if (!input || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch(`/api/projects/${projectId}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10000),
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          frozen.current = null;
          setUncertain(false);
          setOpen(false);
          void query.refetch();
        } else setUncertain(true);
        throw new Error(
          value &&
            typeof value === "object" &&
            "error" in value &&
            typeof value.error === "string"
            ? value.error
            : "Archive change could not be confirmed.",
        );
      }
      const current = parse(value);
      frozen.current = null;
      setUncertain(false);
      setOpen(false);
      cache.setQueryData(["project-archive", projectId], current);
      setNotice(
        current.savedRevision && current.savedRevision !== current.revision
          ? "Earlier change confirmed. The project changed again; review its current state."
          : current.archivedAt
            ? "Project archived. Published applications remain online."
            : "Project restored. Previous work was not restarted.",
      );
      for (const key of [
        "projects",
        "project",
        "project-access",
        "project-settings",
      ])
        void cache.invalidateQueries({
          queryKey: key === "projects" ? [key] : [key, projectId],
        });
    } catch (failure) {
      if (frozen.current) setUncertain(true);
      setError(
        failure instanceof Error
          ? failure.message
          : "Archive change could not be confirmed.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (query.isPending)
    return <p role="status">Checking project archive state…</p>;
  if (query.isError)
    return (
      <section className="project-archive-controls">
        <p role="alert">{query.error.message}</p>
        <button type="button" onClick={() => void query.refetch()}>
          Retry archive status
        </button>
      </section>
    );
  const state = query.data;
  if (!state?.canManage)
    return (
      <p className="settings-field-help">
        Only the project owner can archive or restore it.
      </p>
    );
  return (
    <section className="project-archive-controls">
      <h2>{state.archivedAt ? "Restore project" : "Archive project"}</h2>
      <p>
        {state.archivedAt
          ? "Return this project to your active collection. Previous builds, previews and deployments will not restart."
          : "Remove this project from recent and active lists while keeping its source, conversations, history and sharing. Published applications stay online."}
      </p>
      {state.blockers.length > 0 && (
        <ul>
          {state.blockers.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {blockedByDraft && !state.archivedAt && (
        <p>
          Save or review your unsaved settings before changing archive state.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {uncertain ? (
        <div className="project-settings-actions">
          <p>The result is unconfirmed. Keep the original request for retry.</p>
          <button type="button" disabled={busy} onClick={() => void save()}>
            Retry same archive change
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={
            busy ||
            (blockedByDraft && !state.archivedAt) ||
            state.blockers.length > 0
          }
          onClick={() => {
            frozen.current = {
              requestId: crypto.randomUUID(),
              expectedRevision: state.revision,
              archived: !state.archivedAt,
            };
            setOpen(true);
          }}
        >
          {state.archivedAt ? "Restore project" : "Archive project"}
        </button>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {frozen.current?.archived
              ? "Archive this project?"
              : "Restore this project?"}
          </DialogTitle>
          <DialogDescription>
            {frozen.current?.archived
              ? "Published apps remain online. This preserves source, history, team access and deployment artifacts; it does not delete resources. Stop local previews and finish or reconcile active work first."
              : "This restores the project to active lists. It does not restart previous work or change sharing."}
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Keep reviewing
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy
                ? "Confirming…"
                : uncertain
                  ? "Retry same change"
                  : frozen.current?.archived
                    ? "Confirm archive"
                    : "Confirm restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
