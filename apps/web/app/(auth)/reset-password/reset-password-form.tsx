"use client";
// Recovery secrets live only in this mounted form; never in browser storage or a query URL.
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
type Submission = { proof: string; requestId: string; password: string };
const REQUEST_TIMEOUT_MS = 20_000;
export function ResetPasswordForm(): React.JSX.Element {
  const proof = useRef<string | null>(null);
  const pending = useRef<Submission | null>(null);
  const busyRef = useRef(false);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [done, setDone] = useState(false),
    [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get(
      "recovery",
    );
    window.history.replaceState(null, "", window.location.pathname);
    if (value && /^[A-Za-z0-9_-]{43}$/.test(value)) proof.current = value;
    setReady(true);
    // Strict-mode effect replay must not discard the proof after the fragment was removed.
  }, []);
  async function submit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (busyRef.current || !proof.current) return;
    const form = event.currentTarget,
      data = new FormData(form);
    if (!pending.current) {
      const password = String(data.get("password") ?? "");
      if (
        password.length < 8 ||
        password.length > 128 ||
        password !== data.get("confirm")
      ) {
        setError("Use 8–128 characters and enter the same password twice.");
        return;
      }
      pending.current = {
        proof: proof.current,
        password,
        requestId: crypto.randomUUID(),
      };
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/instance/password-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending.current),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        if (response.status < 500 && response.status !== 429) {
          pending.current = null;
          setUncertain(false);
        } else setUncertain(true);
        throw new Error(
          value &&
            typeof value === "object" &&
            "error" in value &&
            typeof value.error === "string"
            ? value.error
            : "Recovery could not be confirmed. Retry the same submission.",
        );
      }
      if (
        !value ||
        typeof value !== "object" ||
        !("completed" in value) ||
        value.completed !== true
      )
        throw new Error(
          "Recovery could not be confirmed. Retry the same submission.",
        );
      pending.current = null;
      proof.current = null;
      form.reset();
      setDone(true);
    } catch (failure) {
      if (pending.current) setUncertain(true);
      setError(
        failure instanceof Error
          ? failure.message
          : "Recovery could not be confirmed. Retry the same submission.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  if (!ready) return <p role="status">Opening private recovery…</p>;
  if (done)
    return (
      <div role="status">
        <p>Your password has been reset. Sign in again to continue.</p>
        <a className="mt-4 inline-block underline" href="/sign-in">
          Sign in →
        </a>
      </div>
    );
  if (!proof.current)
    return (
      <p>
        Open the complete private link issued on your instance.{" "}
        <a href="/forgot-password" className="underline">
          Get recovery help →
        </a>
      </p>
    );
  return (
    <form className="entry-form" onSubmit={submit} aria-busy={busy}>
      <div className="entry-field">
        <Label htmlFor="new-password">New password</Label>
        <PasswordInput
          id="new-password"
          name="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          disabled={busy || uncertain}
        />
      </div>
      <div className="entry-field">
        <Label htmlFor="confirm-password">Confirm password</Label>
        <PasswordInput
          id="confirm-password"
          name="confirm"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          disabled={busy || uncertain}
        />
      </div>
      {error && (
        <p role="alert" className="entry-message">
          {error}
        </p>
      )}
      {uncertain && (
        <p className="entry-note">
          The result is unconfirmed. Retry sends the same request and password;
          a completed reset will only be acknowledged.
        </p>
      )}
      <Button className="entry-primary" type="submit" disabled={busy}>
        {busy
          ? "Checking recovery…"
          : uncertain
            ? "Retry same submission"
            : "Reset password"}
      </Button>
    </form>
  );
}
