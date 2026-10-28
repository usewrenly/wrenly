"use client";
// Session changes remain Better Auth operations.
import { useTheme } from "@/components/theme-provider";
import { ProfileAvatar } from "@/components/account/profile-avatar";
import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth/auth-client";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ChevronDownIcon, HouseIcon, LayersIcon, LogOutIcon, SettingsIcon, UserIcon, SunIcon, MoonIcon, MonitorIcon } from "lucide-react";
/** Provides keyboard-accessible account actions and clears private browser cache only after confirmed sign-out. */
export function AccountMenu(): React.JSX.Element {
  const { data: session } = authClient.useSession();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = session?.user?.name || session?.user?.email || "Account";
  const signOut = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error)
        throw new Error("Sign-out could not be confirmed. Try again.");
      queryClient.clear();
      window.location.assign("/sign-in");
    } catch {
      setError(
        "Sign-out could not be confirmed. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app-account">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="app-account-trigger"
          aria-label={`Account menu for ${name}`}
          disabled={busy}
        >
          <ProfileAvatar
            name={name}
            userId={session?.user?.id}
            own
            className="app-avatar"
          />
          <span className="app-account-name">
            {busy ? "Signing out…" : name}
          </span>
          <ChevronDownIcon size={13} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="app-account-popup">
          <div className="app-account-identity">
            <ProfileAvatar name={name} userId={session?.user?.id} own className="app-avatar" />
            <div><p>{name}</p>{session?.user?.email && <p>{session.user.email}</p>}</div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link href="/settings" />}>
            <UserIcon /> Account
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/projects" />}>
            <LayersIcon /> Projects
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/settings/security" />}>
            <SettingsIcon />
            Security
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link href="/" />}>
            <HouseIcon /> Home
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="app-account-theme" role="group" aria-label="Appearance">
            <span>Appearance</span>
            <div>{([
              { value: "light", label: "Light", icon: SunIcon },
              { value: "dark", label: "Dark", icon: MoonIcon },
              { value: "system", label: "System", icon: MonitorIcon },
            ] as const).map(({ value, label, icon: Icon }) => (
              <button key={value} type="button" aria-label={`${label} theme`} aria-pressed={theme === value} onClick={() => setTheme(value)}><Icon size={15} aria-hidden="true" /></button>
            ))}</div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={busy}
            onClick={() => {
              void signOut();
            }}
          >
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <p role="alert" className="app-account-error">
          {error}
        </p>
      )}
    </div>
  );
}
