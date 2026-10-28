"use client";
// A frozen action is reconciled before another action can be submitted.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ProfileAvatar } from "@/components/account/profile-avatar";
import { invitationRequest } from "@/lib/accounts/invitations";
import type { ManagedMember } from "@/lib/accounts/member-access";
type Change = {
  requestId: string;
  targetId: string;
  action: "suspend" | "restore";
  expectedRevision: string;
};
/** Preserves target identity and provides read-only recovery for lost management responses. */
export function MemberAccessManager({
  members,
  onRefresh,
}: {
  members: ManagedMember[];
  onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const [review, setReview] = useState<ManagedMember | null>(null),
    [pending, setPending] = useState<Change | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [canRetry, setCanRetry] = useState(false);
  const lock = useRef(false),
    cache = useQueryClient();
  const reviewRegion = useRef<HTMLDivElement>(null),
    lastTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (review) reviewRegion.current?.focus();
  }, [review]);
  async function confirm(change: Change): Promise<void> {
    const saved = await invitationRequest(
      `/api/instance/access/actions/${change.requestId}`,
    );
    if (!saved || typeof saved !== "object" || !("action" in saved))
      throw Error("Saved access status is unavailable.");
    const action = saved.action;
    if (
      action &&
      typeof action === "object" &&
      "requestId" in action &&
      action.requestId === change.requestId &&
      "targetId" in action &&
      action.targetId === change.targetId &&
      "action" in action &&
      action.action === change.action
    ) {
      if (
        !("current" in saved) ||
        !saved.current ||
        typeof saved.current !== "object" ||
        !("revision" in saved.current) ||
        !("revision" in action) ||
        saved.current.revision !== action.revision ||
        !("suspended" in saved.current) ||
        saved.current.suspended !== (change.action === "suspend")
      ) {
        await onRefresh();
        setPending(null);
        setReview(null);
        setCanRetry(false);
        setMessage(
          "That action was recorded, but member access changed again. Review the current status.",
        );
        return;
      }
      await onRefresh();
      await cache.invalidateQueries({ queryKey: ["header-instance-members"] });
      setPending(null);
      setReview(null);
      setCanRetry(false);
      setMessage(
        change.action === "suspend"
          ? "Member access suspended. Projects and history are retained."
          : "Member access restored. They can sign in normally.",
      );
    } else if (action === null) {
      setCanRetry(true);
      setMessage(
        "No saved action was found. Check again or explicitly retry this same request.",
      );
    } else
      throw Error(
        "Saved action does not match this request. Reload and review member access.",
      );
  }
  async function send(retry?: Change): Promise<void> {
    if (
      lock.current ||
      (!retry && pending) ||
      (!retry && (!review?.userId || !review.accessRevision))
    )
      return;
    const change = retry ?? {
      requestId: crypto.randomUUID(),
      targetId: review!.userId!,
      action: review!.suspended ? ("restore" as const) : ("suspend" as const),
      expectedRevision: review!.accessRevision!,
    };
    lock.current = true;
    setBusy(true);
    setPending(change);
    setCanRetry(false);
    setMessage("");
    try {
      await invitationRequest("/api/instance/access/actions", change);
      await confirm(change);
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "Access could not be confirmed."} Check saved access before another change.`,
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function check(): Promise<void> {
    if (!pending || lock.current) return;
    lock.current = true;
    setBusy(true);
    setCanRetry(false);
    try {
      await confirm(pending);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Saved access is unavailable.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="member-management" aria-busy={busy}>
      <h2>Members</h2>
      <p className="settings-field-help">
        Suspending access signs the member out. Their projects and history
        remain theirs.
      </p>
      <ul>
        {members.map((person) => (
          <li key={person.id} className="member-management-row">
            <ProfileAvatar
              name={person.name}
              pictureUrl={person.pictureUrl}
              className="app-avatar"
            />
            <div>
              <strong>{person.name}</strong>
              <span>{person.email}</span>
              <small>
                {(person.isOwner ?? person.role === "owner")
                  ? "Instance owner"
                  : person.suspended === undefined
                    ? "Access status unavailable"
                    : person.suspended
                      ? "Suspended"
                      : "Active"}
              </small>
            </div>
            {(person.isOwner ?? person.role === "owner") ? (
              <span className="member-owner-protected">Protected</span>
            ) : (
              <button
                type="button"
                disabled={
                  busy ||
                  Boolean(pending) ||
                  typeof person.suspended !== "boolean" ||
                  !person.accessRevision ||
                  !person.userId
                }
                onClick={(event) => {
                  lastTrigger.current = event.currentTarget;
                  setReview(person);
                  setMessage("");
                }}
              >
                {person.suspended ? "Restore access" : "Suspend access"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {review && (
        <div
          className="member-access-review"
          role="region"
          aria-label="Review member access"
          ref={reviewRegion}
          tabIndex={-1}
        >
          <h3>
            {review.suspended ? "Restore" : "Suspend"} access for {review.name}?
          </h3>
          <p>{review.email}</p>
          <p>
            {review.suspended
              ? "They must sign in again. Existing sessions and previews will not restart."
              : "They will be signed out and preview access revoked. Active work may block this change. Existing published apps remain deployed."}
          </p>
          <p>
            Projects, credentials and history will not be deleted or
            transferred.
          </p>
          <div>
            <button
              type="button"
              disabled={busy || Boolean(pending)}
              onClick={() => void send()}
            >
              Confirm {review.suspended ? "restore" : "suspension"}
            </button>
            <button
              type="button"
              disabled={busy || Boolean(pending)}
              onClick={() => {
                setReview(null);
                lastTrigger.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {pending && (
        <div className="member-access-recovery">
          <button type="button" disabled={busy} onClick={() => void check()}>
            Check saved access
          </button>
          {canRetry && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void send(pending)}
              >
                Retry this access change
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPending(null);
                  setReview(null);
                  setCanRetry(false);
                  void onRefresh().catch(() =>
                    setMessage(
                      "Member access could not be reloaded. Try refreshing the page.",
                    ),
                  );
                }}
              >
                Reload and review
              </button>
            </>
          )}
        </div>
      )}
      {message && (
        <p role="status" className="settings-notice">
          {message}
        </p>
      )}
    </section>
  );
}
