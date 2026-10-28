"use client";
// Native Better Auth owns credentials and sessions.
import { useRef, useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/auth-client";
import { PasswordInput } from "@/components/auth/password-input";
const ACCOUNT_REQUEST_TIMEOUT_MS = 10_000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
export default function SecuritySettingsPage(): React.JSX.Element {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [uncertain, setUncertain] = useState(false),
    [authRequired, setAuthRequired] = useState(false);
  const submitting = useRef(false);
  async function change(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (submitting.current || uncertain || authRequired) return;
    const form = event.currentTarget,
      data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? ""),
      newPassword = String(data.get("newPassword") ?? "");
    if (newPassword !== data.get("confirmation")) {
      setMessage("Your new passwords do not match.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: data.get("revokeOthers") === "on",
        fetchOptions: { retry: 0, timeout: ACCOUNT_REQUEST_TIMEOUT_MS },
      });
      if (result.error) {
        if (result.error.status >= 500 || result.error.status === 0)
          throw new Error("Unconfirmed password change");
        if (result.error.status === 401 || result.error.status === 403) {
          setAuthRequired(true);
          setMessage("Sign in again before changing your password.");
          return;
        }
        setMessage(
          result.error.message ??
            "Password change was rejected. Check your current password and sign in again if needed.",
        );
      } else setMessage("Password changed.");
    } catch {
      setUncertain(true);
      setMessage(
        "The password change could not be confirmed. Sign in again with your new password to check. If it was not changed, your previous password still applies.",
      );
    } finally {
      form.reset();
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <div>
      <header className="settings-page-heading">
        <p>Keep your account secure</p>
        <h1>Security</h1>
        <span>Your credentials are managed on this instance.</span>
      </header>
      <section className="settings-section">
        <h2>Change password</h2>
        <p>Confirm your current password before choosing a new one.</p>
        <form onSubmit={(event) => void change(event)} aria-busy={busy}>
          <label htmlFor="current-password">Current password</label>
          <PasswordInput
            id="current-password"
            name="currentPassword"
            autoComplete="current-password"
            required
            maxLength={MAX_PASSWORD_LENGTH}
            disabled={busy || uncertain || authRequired}
          />
          <label htmlFor="new-password">New password</label>
          <PasswordInput
            id="new-password"
            name="newPassword"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            disabled={busy || uncertain || authRequired}
          />
          <p className="settings-field-help">8–128 characters.</p>
          <label htmlFor="confirm-password">Confirm new password</label>
          <PasswordInput
            id="confirm-password"
            name="confirmation"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            disabled={busy || uncertain || authRequired}
          />
          <label className="settings-check">
            <input
              type="checkbox"
              name="revokeOthers"
              defaultChecked
              disabled={busy || uncertain || authRequired}
            />
            Sign out my other sessions
          </label>
          <button
            className="settings-primary"
            type="submit"
            disabled={busy || uncertain || authRequired}
          >
            {busy ? "Changing password…" : "Change password"}
          </button>
        </form>
        {message && (
          <p className="settings-notice" role="status">
            {message}
          </p>
        )}
        {(uncertain || authRequired) && (
          <Link href="/sign-in" className="settings-text-link">
            {uncertain ? "Sign in to check your credentials" : "Sign in again"}
          </Link>
        )}
      </section>
      <section className="settings-section">
        <h2>Sign-in protection</h2>
        <p>
          Password sign-in is active. Two-factor authentication is not available
          yet.
        </p>
      </section>
    </div>
  );
}
