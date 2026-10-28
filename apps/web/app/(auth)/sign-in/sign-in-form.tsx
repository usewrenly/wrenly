"use client";
// Better Auth remains the sole session authority.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/auth/password-input";
import { WrenlyMark } from "@/components/wrenly-mark";
import { DocumentationLink } from "@/components/documentation-link";
import { authClient } from "@/lib/auth/auth-client";
export function SignInForm(): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submitting = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setError(null);
    setLoading(true);
    const form = new FormData(event.currentTarget);
    try {
      const { error: failure } = await authClient.signIn.email({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      });
      if (failure) {
        setError(
          failure.message ?? "Check your email and password, then try again.",
        );
        return;
      }
      window.location.href = "/";
    } catch {
      setError(
        "Sign-in could not be completed. Check your connection and try again.",
      );
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }
  return (
    <>
      <form onSubmit={handleSubmit} className="entry-form" aria-busy={loading}>
        <div className="entry-field">
          <Label htmlFor="email">Email address</Label>
          <Input
            className="entry-control"
            id="email"
            name="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            maxLength={254}
            disabled={loading}
            required
          />
        </div>
        <div className="entry-field">
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            name="password"
            placeholder="Enter your password"
            autoComplete="current-password"
            disabled={loading}
            required
          />
        </div>
        {error && (
          <p
            ref={errorRef}
            tabIndex={-1}
            className="entry-message"
            role="alert"
          >
            {error}
          </p>
        )}
        <Button type="submit" className="entry-primary" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
          {loading ? <WrenlyMark className="size-6 wrenly-wing-motion" variant="on-primary" /> : <span aria-hidden="true">↗</span>}
        </Button>
      </form>
      <a href="/forgot-password" className="mt-4 inline-block text-sm underline">Forgot password?</a>
      <p className="entry-note entry-account-note">
        Setting up your own instance? <DocumentationLink guide="guides/instance-setup" />
      </p>
    </>
  );
}
