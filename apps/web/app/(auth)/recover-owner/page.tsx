"use client";
// Proof stays in memory and is cleared from history immediately.
import { EntryFrame } from "@/components/auth/entry-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
type Identity = { id: string; email: string };
export default function RecoverOwnerPage(): React.JSX.Element {
  const [proof, setProof] = useState("");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  const submitting = useRef(false);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestId = useRef<string | null>(null);
  useEffect(() => {
    // Development effect replay sees the cleaned URL; keep the captured proof in memory.
    const suppliedProof = new URLSearchParams(
      window.location.hash.slice(1),
    ).get("recovery");
    if (suppliedProof !== null) setProof(suppliedProof);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    const controller = new AbortController();
    const check = async (): Promise<void> => {
      try {
        const response = await apiFetch("/api/auth/get-session", {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10_000),
          ]),
        });
        if (!response.ok) throw new Error("Session unavailable");
        const value: unknown = await response.json();
        if (
          value &&
          typeof value === "object" &&
          "user" in value &&
          value.user &&
          typeof value.user === "object" &&
          "id" in value.user &&
          typeof value.user.id === "string" &&
          "email" in value.user &&
          typeof value.user.email === "string"
        ) {
          if (!controller.signal.aborted)
            setIdentity({ id: value.user.id, email: value.user.email });
        }
      } catch {
        if (!controller.signal.aborted)
          setError("Your session could not be checked. Reload to try again.");
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    };
    void check();
    return () => controller.abort();
  }, []);
  const confirm = async (): Promise<void> => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      requestId.current ??= crypto.randomUUID();
      const response = await apiFetch("/api/instance/recover-owner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proof, requestId: requestId.current }),
        signal: AbortSignal.timeout(15_000),
      });
      const value: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          value &&
            typeof value === "object" &&
            "error" in value &&
            typeof value.error === "string"
            ? value.error
            : "Owner recovery could not be completed.",
        );
      setDone(true);
      setProof("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Owner recovery could not be completed.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <EntryFrame
      eyebrow="Verified recovery"
      title="Recover instance ownership"
      description="Confirm the existing account selected by your operator."
    >
      <div className="entry-form">
        {error && (
          <p
            ref={errorRef}
            className="entry-message"
            tabIndex={-1}
            role="alert"
          >
            {error}
          </p>
        )}
        {checking ? (
          <p role="status">Checking your session…</p>
        ) : done ? (
          <>
            <p>
              Instance ownership is confirmed. Existing projects and credentials
              are preserved.
            </p>
            <a href="/" className="underline">
              Open Wrenly
            </a>
          </>
        ) : identity ? (
          <>
            <p>
              Confirm <strong>{identity.email}</strong> as this instance’s owner
              using the private link supplied by its operator. This does not
              transfer other accounts’ projects.
            </p>
            <label className="block">
              Recovery code
              <Input
                type="password"
                autoComplete="off"
                value={proof}
                onChange={(event) => setProof(event.target.value)}
                className="entry-control mt-2"
              />
            </label>
            <Button
              type="button"
              disabled={busy || !proof}
              onClick={() => {
                void confirm();
              }}
              className="entry-primary"
            >
              {busy ? "Confirming…" : "Confirm instance owner"}
            </Button>
          </>
        ) : (
          <>
            <p>
              Sign in to the existing account selected by your operator, then
              reopen the original private recovery link.
            </p>
            <a href="/sign-in" className="underline">
              Sign in
            </a>
          </>
        )}
      </div>
    </EntryFrame>
  );
}
