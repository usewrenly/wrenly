"use client";
// The fragment proof never enters browser storage or normal URLs.
import { EntryFrame } from "@/components/auth/entry-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useRef, useState } from "react";
import { invitationRequest } from "@/lib/accounts/invitations";
type Details = { email: string; existingAccount: boolean; accepted: boolean };
export default function AcceptInvitationPage(): React.JSX.Element {
  const [input, setInput] = useState<{ id: string; proof: string } | null>(
    null,
  );
  const [details, setDetails] = useState<Details | null>(null);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState(0);
  const [created, setCreated] = useState(false);
  const requestId = useRef<string | null>(null);
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const id = fragment.get("invitation"),
      proof = fragment.get("proof");
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    if (id && proof) setInput({ id, proof });
    else {
      setError(
        "Open the private invitation link supplied by your instance owner.",
      );
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!input) return;
    const controller = new AbortController();
    const inspect = async (): Promise<void> => {
      setBusy(true);
      setError("");
      try {
        const value = await invitationRequest(
          "/api/instance/invitations/inspect",
          input,
          controller.signal,
        );
        if (
          !value ||
          typeof value !== "object" ||
          !("email" in value) ||
          typeof value.email !== "string" ||
          !("existingAccount" in value) ||
          typeof value.existingAccount !== "boolean" ||
          !("accepted" in value) ||
          typeof value.accepted !== "boolean"
        )
          throw new Error("Invitation details could not be read.");
        const session = await invitationRequest(
          "/api/auth/get-session",
          undefined,
          controller.signal,
        );
        let email: string | null = null;
        if (
          session &&
          typeof session === "object" &&
          "user" in session &&
          session.user &&
          typeof session.user === "object" &&
          "email" in session.user &&
          typeof session.user.email === "string"
        )
          email = session.user.email;
        if (!controller.signal.aborted) {
          setDetails({
            email: value.email,
            existingAccount: value.existingAccount,
            accepted: value.accepted,
          });
          setSignedInEmail(email);
        }
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Invitation could not be checked.",
          );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void inspect();
    return () => controller.abort();
  }, [input, retry]);
  const accept = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (!input || !details || submitting.current) return;
    submitting.current = true;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? ""),
      password = String(form.get("password") ?? "");
    setBusy(true);
    setError("");
    try {
      requestId.current ??= crypto.randomUUID();
      const value = await invitationRequest(
        "/api/instance/invitations/accept",
        {
          ...input,
          requestId: requestId.current,
          ...(details.existingAccount ? {} : { name, password }),
        },
      );
      if (
        !value ||
        typeof value !== "object" ||
        !("accountCreated" in value) ||
        typeof value.accountCreated !== "boolean"
      )
        throw new Error(
          "The acknowledgement could not be read. Retry this acceptance from the same form.",
        );
      if (value.accountCreated) {
        setCreated(true);
        await invitationRequest("/api/auth/sign-in/email", {
          email: details.email,
          password,
        });
      }
      window.location.href = "/";
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Invitation acceptance failed.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const wrongAccount =
    signedInEmail !== null &&
    signedInEmail.toLowerCase() !== details?.email.toLowerCase();
  return (
    <EntryFrame
      eyebrow="You’re invited"
      title="Join this Wrenly instance"
      description="Set up your access and start building on this instance."
    >
      <div className="entry-form">
        {error && (
          <div
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="entry-message space-y-2"
          >
            <p>{error}</p>
            {input && !details && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setRetry((count) => count + 1)}
                className="underline"
              >
                Try again
              </button>
            )}
          </div>
        )}
        {busy && <p role="status">Checking your invitation…</p>}
        {created ? (
          <>
            <p>
              Your account and membership were created. If sign-in did not
              finish, sign in normally using the password you chose.
            </p>
            <a href="/sign-in" className="underline">
              Sign in
            </a>
          </>
        ) : details?.accepted ? (
          <>
            <p>This invitation was already accepted. Sign in to continue.</p>
            <a href="/sign-in" className="underline">
              Sign in
            </a>
          </>
        ) : (
          details && (
            <>
              <p>
                You’re invited as <strong>{details.email}</strong>. Member
                access lets you create private projects; it does not grant
                instance administration or access to other people’s projects.
              </p>
              {wrongAccount ? (
                <>
                  <p>
                    You are signed in as {signedInEmail}. Switch to the invited
                    account, then reopen the original invitation link.
                  </p>
                  <a href="/sign-in" className="underline">
                    Open sign-in
                  </a>
                </>
              ) : details.existingAccount && !signedInEmail ? (
                <>
                  <p>
                    This email already has an account. Sign in to it, then
                    reopen the original invitation link.
                  </p>
                  <a href="/sign-in" className="underline">
                    Sign in
                  </a>
                </>
              ) : (
                <form
                  onSubmit={(event) => {
                    void accept(event);
                  }}
                  className="entry-form"
                >
                  {!details.existingAccount && (
                    <>
                      <label className="block">
                        Name
                        <Input
                          name="name"
                          required
                          maxLength={100}
                          autoComplete="name"
                          className="entry-control mt-2"
                        />
                      </label>
                      <label className="block">
                        Password
                        <Input
                          name="password"
                          type="password"
                          required
                          minLength={8}
                          maxLength={128}
                          autoComplete="new-password"
                          className="entry-control mt-2"
                        />
                      </label>
                      <p className="text-sm opacity-70">
                        Use 8–128 characters.
                      </p>
                    </>
                  )}
                  <Button
                    type="submit"
                    disabled={busy}
                    className="entry-primary"
                  >
                    {busy ? "Accepting…" : "Accept invitation"}
                  </Button>
                </form>
              )}
            </>
          )
        )}
      </div>
    </EntryFrame>
  );
}
