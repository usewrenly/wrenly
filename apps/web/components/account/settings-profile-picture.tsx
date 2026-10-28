"use client";
// A preview is never evidence that an upload persisted.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ProfileAvatar } from "@/components/account/profile-avatar";
import { readOwnPicture, useOwnPicture } from "@/lib/accounts/profile-pictures";
const MAX_PICTURE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
type PendingPicture = {
  mutationId: string;
  expectedRevision: string | null;
  remove: boolean;
};
/** Provides explicit upload/removal and read-only reconciliation of uncertain writes. */
export function SettingsProfilePicture({
  userId,
  name,
}: {
  userId: string;
  name: string;
}): React.JSX.Element {
  const picture = useOwnPicture(userId);
  const cache = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPicture | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  async function confirm(change: PendingPicture): Promise<void> {
    const saved = await readOwnPicture(userId);
    cache.setQueryData(["profile-picture", userId], saved);
    await cache.invalidateQueries({ queryKey: ["header-instance-members"] });
    if (
      saved.mutationId === change.mutationId &&
      Boolean(saved.url) === !change.remove
    ) {
      setPending(null);
      setFile(null);
      if (input.current) input.current.value = "";
      setMessage(change.remove ? "Picture removed." : "Picture saved.");
    } else if (saved.revision !== change.expectedRevision) {
      setPending(null);
      setMessage(
        "Your picture changed elsewhere. Your selection is preserved; review the saved picture before saving again.",
      );
    } else {
      setCanRetry(true);
      setMessage(
        "The saved picture is unchanged. Check again, or explicitly retry this same change.",
      );
    }
  }
  async function check(): Promise<void> {
    if (!pending || lock.current) return;
    lock.current = true;
    setBusy(true);
    setCanRetry(false);
    try {
      await confirm(pending);
    } catch {
      setMessage(
        "Your saved picture could not be checked. Check again or sign in again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function save(
    remove: boolean,
    retryChange?: PendingPicture,
  ): Promise<void> {
    if (
      lock.current ||
      (pending && !retryChange) ||
      !picture.data ||
      (!remove && !file)
    )
      return;
    const change = retryChange ?? {
      mutationId: crypto.randomUUID(),
      expectedRevision: picture.data.revision,
      remove,
    };
    lock.current = true;
    setBusy(true);
    setPending(change);
    setCanRetry(false);
    setMessage("");
    try {
      const query = change.expectedRevision
        ? "?expectedRevision=" + encodeURIComponent(change.expectedRevision)
        : "";
      const response = await fetch("/api/account/profile-picture" + query, {
        method: remove ? "DELETE" : "PUT",
        headers: {
          "Idempotency-Key": change.mutationId,
          ...(remove ? {} : { "Content-Type": file!.type }),
        },
        body: remove ? undefined : file!,
        credentials: "same-origin",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok && [400, 401, 403, 409, 413].includes(response.status)) {
        setPending(null);
        if (response.status === 409) {
          await picture.refetch();
          setMessage(
            "Your picture changed elsewhere. Review the saved picture before saving again.",
          );
        } else
          setMessage(
            response.status === 401 || response.status === 403
              ? "Sign in again before changing your picture."
              : "This picture could not be processed. Choose a static PNG, JPEG or WebP under 2 MiB and 16 megapixels.",
          );
        return;
      }
      await confirm(change);
    } catch {
      setMessage(
        "The change could not be confirmed. Check your saved picture before submitting another change.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const blocked = busy || Boolean(pending);
  return (
    <div className="settings-picture" aria-busy={busy}>
      <div className="settings-picture-preview">
        <ProfileAvatar
          name={name}
          userId={userId}
          own
          className="settings-profile-avatar"
        />
        {preview && <img src={preview} alt="Selected picture preview" />}
      </div>
      <div className="settings-picture-controls">
        <h3>Profile picture</h3>
        <p>PNG, JPEG or WebP · up to 2 MiB. Saved on this instance.</p>
        <label className="settings-picture-choose">
          Choose picture
          <input
            ref={input}
            aria-label="Choose profile picture"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={blocked}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (!selected) return;
              if (
                !["image/png", "image/jpeg", "image/webp"].includes(
                  selected.type,
                ) ||
                selected.size > MAX_PICTURE_BYTES ||
                !selected.size
              ) {
                setMessage("Choose a PNG, JPEG or WebP smaller than 2 MiB.");
                event.target.value = "";
                return;
              }
              setFile(selected);
              setMessage("Preview only. Save when you are ready.");
            }}
          />
        </label>
        {file && (
          <>
            <button
              type="button"
              className="settings-primary"
              disabled={blocked || !picture.data}
              onClick={() => void save(false)}
            >
              Save picture
            </button>
            <button
              type="button"
              disabled={blocked}
              onClick={() => {
                setFile(null);
                if (input.current) input.current.value = "";
                setMessage("");
              }}
            >
              Cancel selection
            </button>
          </>
        )}
        {picture.data?.url && (
          <button
            type="button"
            disabled={blocked}
            onClick={() => {
              if (window.confirm("Remove your profile picture?"))
                void save(true);
            }}
          >
            Remove picture
          </button>
        )}
        {pending && canRetry && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(pending.remove, pending)}
          >
            Retry this picture change
          </button>
        )}
        {pending && (
          <button type="button" disabled={busy} onClick={() => void check()}>
            Check saved picture
          </button>
        )}
        {picture.isError && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void picture.refetch()}
          >
            Retry picture
          </button>
        )}
        {message && <p role="status">{message}</p>}
        {picture.isError && (
          <p role="alert">
            Your picture could not be loaded. Try again before saving.
          </p>
        )}
      </div>
    </div>
  );
}
