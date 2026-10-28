"use client";
// Search state belongs to Shell; shortcut has a real focus target.
import { usePathname } from "next/navigation";
import { useProjects } from "@/hooks/use-projects";
import { InstanceMembers } from "./instance-members";
import { AccountMenu } from "./account-menu";
import { SearchIcon } from "lucide-react";
interface TopBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  mobileNavigation: React.ReactNode;
  onMobileSearch: () => void;
}
/** Shows location context without implying team switching or project sharing. */
export function TopBar({
  search,
  onSearchChange,
  searchRef,
  mobileNavigation,
  onMobileSearch,
}: TopBarProps): React.JSX.Element {
  const pathname = usePathname();
  const { data: projects } = useProjects();
  const projectId = pathname.startsWith("/p/")
    ? pathname.split("/")[2]
    : undefined;
  const location = projectId
    ? pathname.endsWith("/settings")
      ? "Project settings"
      : (projects?.find((project) => project.id === projectId)?.name ??
        "Project")
    : pathname.startsWith("/projects/deployments")
      ? "Deployments"
      : pathname.startsWith("/settings/connections")
        ? "Connections"
        : pathname.startsWith("/projects/drafts")
          ? "Drafts"
          : pathname === "/projects"
            ? "Projects"
            : pathname === "/get-started"
              ? "Get started"
              : pathname === "/settings/models"
                ? "Model preferences"
                : pathname === "/settings/security"
                  ? "Account security"
                  : pathname === "/settings/appearance"
                    ? "Appearance"
                    : pathname.startsWith("/settings/providers")
                      ? "Model providers"
                      : pathname.startsWith("/settings/access")
                        ? "Instance access"
                        : pathname.startsWith("/settings/legacy-projects")
                          ? "Project recovery"
                          : pathname.startsWith("/settings")
                            ? "Settings"
                            : "Home";
  return (
    <header className="app-topbar">
      {mobileNavigation}
      <div className="app-location" aria-label="Current location">
        <span className="app-location-context">
          Your instance <span aria-hidden="true">/</span>
        </span>
        <span className="app-location-current" title={location}>
          {location}
        </span>
      </div>
      <div className="app-header-actions">
        <div className="app-desktop-search">
          <SearchIcon aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search projects"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search projects…"
          />
          <kbd>⌘ / Ctrl K</kbd>
        </div>
        <button
          type="button"
          className="app-icon-button app-mobile-control"
          aria-label="Search projects"
          onClick={onMobileSearch}
        >
          <SearchIcon />
        </button>
        <InstanceMembers />
        <AccountMenu />
      </div>
    </header>
  );
}
