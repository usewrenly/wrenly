//
// Client component — handles the admin account creation form.
// On success, signs in automatically and redirects to home.

"use client";

import { apiFetch } from "@/lib/api";

import { PasswordInput } from "@/components/auth/password-input";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SetupForm({
  initialProof = "",
}: {
  initialProof?: string;
}): React.JSX.Element {
  const [manualProof, setManualProof] = useState(false);
  const submitting = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [proof, setProof] = useState("");
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    setProof(initialProof);
  }, [initialProof]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function handleSubmit(
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const name = form.get("name") as string;
    const email = form.get("email") as string;
    const password = form.get("password") as string;

    try {
      // The protected owner endpoint creates credentials through Better Auth inside its transaction.
      const res = await apiFetch("/api/instance/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          proof,
          requestId: requestId.current,
        }),
        credentials: "include", // include cookies in request
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? "Setup failed");
      }

      // Sign in immediately after creating account
      const signIn = await apiFetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        credentials: "include",
      });

      if (!signIn.ok)
        throw new Error(
          "Your account was created, but sign-in could not be confirmed. Open /sign-in with your new credentials.",
        );
      window.location.href = "/get-started";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="entry-form" aria-busy={loading}>
      <div className="entry-proof">
        {initialProof && !manualProof ? (
          <>
            <p className="entry-message">
              Private setup link received. Your code will be checked when you
              create the owner account.
            </p>
            <button
              type="button"
              className="entry-text-action self-start text-xs"
              onClick={() => setManualProof(true)}
            >
              Enter a setup code manually
            </button>
            <input id="proof" type="hidden" value={proof} />
          </>
        ) : (
          <>
            <p className="entry-note">
              Run bun run setup in your Wrenly installation and open the private
              link printed in the terminal. If you copied its code instead,
              enter it below.
            </p>
            <div className="entry-field">
              <Label htmlFor="proof">Setup code</Label>
              <Input
                className="entry-control"
                id="proof"
                type="password"
                value={proof}
                disabled={loading}
                onChange={(event) => setProof(event.target.value)}
                autoComplete="off"
                required
              />
            </div>
          </>
        )}
      </div>
      <div className="entry-field">
        <Label htmlFor="name">Name</Label>
        <Input
          className="entry-control"
          disabled={loading}
          id="name"
          name="name"
          placeholder="Your name"
          autoComplete="name"
          maxLength={100}
          required
        />
      </div>

      <div className="entry-field">
        <Label htmlFor="email">Email</Label>
        <Input
          className="entry-control"
          disabled={loading}
          id="email"
          name="email"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          maxLength={254}
          required
        />
      </div>

      <div className="entry-field">
        <Label htmlFor="password">Password</Label>
        <PasswordInput
          disabled={loading}
          id="password"
          name="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
        />
        <p className="entry-note">8–128 characters</p>
      </div>

      {error && (
        <p ref={errorRef} tabIndex={-1} role="alert" className="entry-message">
          {error}
        </p>
      )}

      <Button type="submit" className="entry-primary" disabled={loading}>
        {loading ? "Setting up..." : "Create your account"}
      </Button>
    </form>
  );
}
