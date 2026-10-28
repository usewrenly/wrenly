"use client";
// Navigation hints never grant server authority.
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpenIcon,
  UserIcon,
  ShieldIcon,
  PaletteIcon,
  CpuIcon,
  PlugIcon,
  UsersIcon,
} from "lucide-react";
import { useSetupSummary } from "@/lib/onboarding/setup-summary";
const PERSONAL_LINKS = [
  { href: "/settings", label: "Account", icon: UserIcon },
  { href: "/settings/security", label: "Security", icon: ShieldIcon },
  { href: "/settings/appearance", label: "Appearance", icon: PaletteIcon },
  { href: "/settings/models", label: "Models", icon: CpuIcon },
  { href: "/settings/skills", label: "Skills", icon: BookOpenIcon },
  { href: "/settings/connections", label: "Connections", icon: PlugIcon },
];
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const path = usePathname(),
    summary = useSetupSummary();
  return (
    <div className="settings-frame">
      <nav className="settings-navigation" aria-label="Settings sections">
        <p>Your settings</p>
        <div>
          {PERSONAL_LINKS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={path === href ? "page" : undefined}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </Link>
          ))}
        </div>
        {summary.data?.role === "owner" && !summary.isError && (
          <>
            <p>Instance</p>
            <div>
              <Link
                href="/settings/providers"
                aria-current={
                  path === "/settings/providers" ? "page" : undefined
                }
              >
                <PlugIcon size={15} aria-hidden="true" />
                Providers
              </Link>
              <Link
                href="/settings/access"
                aria-current={path === "/settings/access" ? "page" : undefined}
              >
                <UsersIcon size={15} aria-hidden="true" />
                Members
              </Link>
            </div>
          </>
        )}
        {summary.isError && (
          <div className="settings-nav-error">
            <span>Instance settings could not be checked.</span>
            <button type="button" onClick={() => void summary.refetch()}>
              Try again
            </button>
          </div>
        )}
      </nav>
      <div className="settings-content">{children}</div>
    </div>
  );
}
