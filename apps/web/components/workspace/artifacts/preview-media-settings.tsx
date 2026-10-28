"use client";
// Exact-host media approvals retain their reviewed body and request ID for explicit retry.
import { ImageIcon } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
const MAX_MEDIA_HOSTS = 12;

interface Policy {
  revision: string;
  origins: string[];
  availableOrigins: string[];
  canManage: boolean;
  savedRevision?: string;
}
interface Input {
  requestId: string;
  expectedRevision: string;
  origins: string[];
}
function parse(value: unknown): Policy {
  if (
    !value ||
    typeof value !== "object" ||
    !("revision" in value) ||
    typeof value.revision !== "string" ||
    !("origins" in value) ||
    !Array.isArray(value.origins) ||
    !value.origins.every((v) => typeof v === "string") ||
    !("availableOrigins" in value) ||
    !Array.isArray(value.availableOrigins) ||
    !value.availableOrigins.every((v) => typeof v === "string") ||
    !("canManage" in value) ||
    typeof value.canManage !== "boolean"
  )
    throw new Error("Invalid media settings response.");
  return {
    revision: value.revision,
    origins: value.origins,
    availableOrigins: value.availableOrigins,
    canManage: value.canManage,
    ...("savedRevision" in value && typeof value.savedRevision === "string"
      ? { savedRevision: value.savedRevision }
      : {}),
  };
}
/** Polling only reads policy; changes require a frozen explicit owner action. */
export function PreviewMediaSettings({
  projectId,
  onRevision,
  presentation = "disclosure",
}: {
  projectId: string;
  presentation?: "toolbar" | "disclosure";
  onRevision: (revision: string) => void;
}): React.JSX.Element {
  const [customOrigin, setCustomOrigin] = useState("");
  const [policy, setPolicy] = useState<Policy | null>(null),
    [draft, setDraft] = useState<string[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const pending = useRef<Input | null>(null),
    dirty = useRef(false),
    controller = useRef<AbortController | null>(null),
    saving = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    generation.current++;
    dirty.current = false;
    pending.current = null;
    setPolicy(null);
    setDraft([]);
    setError(null);
    setUncertain(false);
    setBusy(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      const observed = generation.current;
      try {
        if (saving.current) return;
        const response = await apiFetch(
          `/api/projects/${projectId}/preview-media`,
          { signal: abort.signal },
        );
        const value: unknown = await response.json();
        if (!response.ok)
          throw new Error("Preview media settings are unavailable.");
        const next = parse(value);
        if (
          abort.signal.aborted ||
          saving.current ||
          observed !== generation.current
        )
          return;
        setPolicy(next);
        onRevision(next.revision);
        if (!dirty.current && !pending.current) setDraft(next.origins);
      } catch (e) {
        if (!abort.signal.aborted && observed === generation.current)
          setError(
            e instanceof Error
              ? e.message
              : "Media settings could not be loaded.",
          );
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [projectId, onRevision]);
  const save = async (): Promise<void> => {
    const abort = controller.current;
    if (!policy?.canManage || !abort || saving.current) return;
    const request = pending.current ?? {
      requestId: crypto.randomUUID(),
      expectedRevision: policy.revision,
      origins: [...draft].sort(),
    };
    pending.current = request;
    generation.current++;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/projects/${projectId}/preview-media`,
        {
          method: "PATCH",
          signal: abort.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      const value: unknown = await response.json();
      if (abort.signal.aborted) return;
      if (!response.ok) {
        if ([400, 401, 403, 404, 409].includes(response.status)) {
          pending.current = null;
          setUncertain(false);
          dirty.current = false;
        }
        throw new Error(
          value &&
            typeof value === "object" &&
            "error" in value &&
            typeof value.error === "string"
            ? value.error
            : "This save could not be confirmed.",
        );
      }
      const next = parse(value);
      setPolicy(next);
      setDraft(next.origins);
      dirty.current = false;
      pending.current = null;
      setUncertain(false);
      onRevision(next.revision);
      if (next.savedRevision && next.savedRevision !== next.revision)
        setError(
          "Your save was recorded, then settings changed again. Current settings are shown.",
        );
    } catch (e) {
      if (!abort.signal.aborted) {
        setUncertain(pending.current !== null);
        setError(
          e instanceof Error ? e.message : "This save could not be confirmed.",
        );
      }
    } finally {
      saving.current = false;
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  const label = "Media Permissions";
  const content = (
    <div className="preview-media-content">
      <p>
        Bundled images and video work locally. Approved hosts receive media
        requests from your browser. This does not give the model web browsing
        access.
      </p>
      {Array.from(new Set([...(policy?.availableOrigins ?? []), ...draft])).map((origin) => (
        <label key={origin} className="preview-media-host">
          <input
            type="checkbox"
            checked={draft.includes(origin)}
            disabled={!policy?.canManage || busy || uncertain}
            onChange={(event) => {
              dirty.current = true;
              setDraft((current) =>
                event.target.checked
                  ? [...current, origin]
                  : current.filter((value) => value !== origin),
              );
            }}
          />
          <span>{origin.replace("https://", "")}</span>
        </label>
      ))}
      {policy?.canManage && <div className="preview-media-custom">
        <label htmlFor={`${projectId}-media-origin`}>Add a media host</label>
        <div><input id={`${projectId}-media-origin`} type="url" value={customOrigin} placeholder="https://cdn.example.com" disabled={busy || uncertain}
          onChange={event => setCustomOrigin(event.target.value)} />
          <button type="button" disabled={busy || uncertain || !customOrigin.trim()} onClick={() => {
            try {
              const value = customOrigin.trim(), url = new URL(value);
              if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("Use an HTTPS host only, without a path or credentials.");
              if (draft.length >= MAX_MEDIA_HOSTS) throw new Error(`You can approve up to ${MAX_MEDIA_HOSTS} hosts.`);
              dirty.current = true; setDraft(current => Array.from(new Set([...current, url.origin]))); setCustomOrigin(""); setError(null);
            } catch (failure) { setError(failure instanceof Error ? failure.message : "Enter a valid HTTPS media host."); }
          }}>Add host</button></div>
        <p>Review the host, then save. Only images and video are permitted; this does not enable model browsing.</p>
      </div>}
      {policy && !policy.canManage && (
        <p>The project owner manages these permissions.</p>
      )}
      {policy?.canManage && (
        <button
          type="button"
          onClick={() => void save()}
          disabled={
            busy ||
            (!uncertain &&
              draft.slice().sort().join() ===
                policy.origins.slice().sort().join())
          }
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 disabled:opacity-50"
        >
          {busy
            ? "Saving…"
            : uncertain
              ? "Retry the same save"
              : "Save media permissions"}
        </button>
      )}
      {uncertain && (
        <p>
          Save outcome unknown. Retry the same save before making another
          change.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        Changes reload this workspace preview. Reload or close existing
        standalone preview tabs too. External scripts, API requests and embedded
        players remain blocked.
      </p>
    </div>
  );
  if (presentation === "toolbar")
    return (
      <Popover.Root>
        <Popover.Trigger
          className="preview-details-trigger workspace-preview-media-trigger"
          aria-label="Preview media permissions"
        >
          {label}
        </Popover.Trigger>
        <Popover.Portal keepMounted>
          <Popover.Positioner
            side="bottom"
            align="start"
            sideOffset={10}
            className="preview-details-positioner"
          >
            <Popover.Popup className="preview-details-popup workspace-preview-media-popup">
              <Popover.Title>Preview media permissions</Popover.Title>
              {content}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    );
  return (
    <details className="workspace-preview-help workspace-preview-media px-1 py-2">
      <summary className="cursor-pointer"><ImageIcon size={16} aria-hidden="true" />{label}</summary>
      {content}
    </details>
  );
}
