"use client";
// Frozen confirmation protects uncertain saves.
import { SettingsProfilePicture } from "@/components/account/settings-profile-picture";
import { useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth/auth-client";
const ACCOUNT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_DISPLAY_NAME_LENGTH = 100;
type ProfileSave = { userId: string; name: string };
export default function AccountSettingsPage(): React.JSX.Element {
  const { data: session, isPending, refetch } = authClient.useSession();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null),
    [pending, setPending] = useState<ProfileSave | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const submitting = useRef(false);
  const signOutLock = useRef(false);
  async function signOut(): Promise<void> {
    if (signOutLock.current) return;
    signOutLock.current = true;
    setSigningOut(true);
    setSignOutError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign-out failed");
      cache.clear();
      window.location.assign("/sign-in");
    } catch {
      setSignOutError(
        "Sign-out could not be confirmed. Check your connection and try again.",
      );
    } finally {
      signOutLock.current = false;
      setSigningOut(false);
    }
  }
  const user = session?.user,
    name = draft ?? user?.name ?? "";
  async function confirm(snapshot: ProfileSave): Promise<void> {
    const response = await authClient.getSession({
      query: { disableCookieCache: true },
      fetchOptions: { retry: 0, timeout: ACCOUNT_REQUEST_TIMEOUT_MS },
    });
    if (
      response.error ||
      !response.data ||
      response.data.user.id !== snapshot.userId
    )
      throw new Error(
        "Your saved profile could not be checked. Sign in again if your session has expired.",
      );
    await refetch();
    if (response.data.user.name === snapshot.name) {
      setPending(null);
      setDraft(null);
      setMessage("Profile saved.");
      await cache.invalidateQueries({ queryKey: ["header-instance-members"] });
    } else {
      setPending(null);
      setMessage(
        `Your saved name is “${response.data.user.name}”. Your draft is preserved; review it before saving again.`,
      );
    }
  }
  async function checkSaved(): Promise<void> {
    if (!pending || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await confirm(pending);
    } catch {
      setMessage(
        "Saved profile could not be confirmed. Your draft is preserved. Check again or sign in again.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!user || submitting.current || pending) return;
    const snapshot = { userId: user.id, name: name.trim() };
    if (!snapshot.name || snapshot.name.length > MAX_DISPLAY_NAME_LENGTH)
      return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    setPending(snapshot);
    try {
      const result = await authClient.updateUser({
        name: snapshot.name,
        fetchOptions: { retry: 0, timeout: ACCOUNT_REQUEST_TIMEOUT_MS },
      });
      if (result.error) throw new Error("Save unconfirmed");
      await confirm(snapshot);
    } catch {
      setMessage(
        "The save could not be confirmed. Check your saved profile before submitting another change.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  if (isPending)
    return (
      <p className="settings-notice" role="status">
        Reading your account…
      </p>
    );
  if (!user)
    return (
      <div className="settings-notice" role="alert">
        <p>Your account could not be loaded.</p>
        <button type="button" onClick={() => void refetch()}>
          Try again
        </button>
        <Link href="/sign-in">Sign in</Link>
      </div>
    );
  return (
    <div className="account-settings">
      <header className="settings-page-heading">
        <p>Your workspace identity</p>
        <h1>Account</h1>
        <span>Manage how you appear on this Wrenly instance.</span>
      </header>
      <section className="settings-section">
        <div className="settings-profile-heading">
          <div>
            <h2>Your profile</h2>
            <p>{user.email}</p>
          </div>
        </div>
        <SettingsProfilePicture
          key={user.id}
          userId={user.id}
          name={user.name}
        />
        <form onSubmit={(event) => void save(event)} aria-busy={busy}>
          <label htmlFor="profile-name">Display name</label>
          <input
            id="profile-name"
            name="name"
            value={name}
            onChange={(event) => setDraft(event.target.value)}
            required
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            disabled={busy || Boolean(pending)}
            autoComplete="name"
          />
          <p className="settings-field-help">
            Used in your profile and workspace messages.
          </p>
          <div className="settings-readonly">
            <span>Sign-in email</span>
            <strong>{user.email}</strong>
            <p>Email changes are not available in this account flow.</p>
          </div>
          <div className="settings-form-actions">
            <button
              className="settings-primary"
              type="submit"
              disabled={
                busy ||
                Boolean(pending) ||
                !name.trim() ||
                name.trim() === user.name
              }
            >
              {busy ? "Checking…" : "Save profile"}
            </button>
            {pending && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void checkSaved()}
              >
                Check saved profile
              </button>
            )}
          </div>
        </form>
        {message && (
          <p role="status" className="settings-notice">
            {message}
          </p>
        )}
        {pending && (
          <Link href="/sign-in" className="settings-text-link">
            Sign in again
          </Link>
        )}
      </section>
      <section className="settings-section">
        <h2>Sign out</h2>
        <p>End your session on this browser.</p>
        <button
          type="button"
          className="settings-sign-out"
          disabled={signingOut || busy || Boolean(pending)}
          onClick={() => void signOut()}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
        {signOutError && (
          <p role="alert" className="settings-notice">
            {signOutError}
          </p>
        )}
      </section>
    </div>
  );
}
