"use client";
// One navigation model for desktop and the focus-managed mobile drawer.
import { SetupProgressCard } from "./setup-progress-card";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ProjectListError, useProjects } from "@/hooks/use-projects";
import { relativeTime } from "@/lib/format";
import { WrenlyMark } from "@/components/wrenly-mark";
import {
  ArrowUpRightIcon,
  HouseIcon,
  CircleDotIcon,
  LayersIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
const SIDEBAR_PROJECT_LIMIT = 6;
type Filter = "all" | "active" | "failed";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "In progress" },
  { id: "failed", label: "Failed" },
];
const ACTIVE_STATUSES = new Set(["pending", "generating", "building"]);
const LABELS: Record<string, string> = {
  pending: "Queued",
  generating: "Generating",
  building: "Building",
  success: "Build succeeded",
  failed: "Build failed",
};
/** Renders only accessible projects, with distinct empty, filtered, loading and failed states. */
export function ProjectRail({
  search,
  onSearchChange,
  searchInputRef,
  onNavigate,
}: {
  search: string;
  onSearchChange?: (value: string) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  onNavigate?: () => void;
}): React.JSX.Element {
  const pathname = usePathname();
  const [filter, setFilter] = useState<Filter>("all");
  const {
    data: projects = [],
    isPending,
    isError,
    error,
    refetch,
  } = useProjects();
  const matching = projects
    .filter((project) =>
      project.name.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .filter(
      (project) =>
        filter === "all" ||
        (filter === "active"
          ? ACTIVE_STATUSES.has(project.latestBuild?.status ?? "")
          : project.latestBuild?.status === "failed"),
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const visible = matching.slice(0, SIDEBAR_PROJECT_LIMIT);
  return (
    <nav className="app-rail" aria-label="Workspace navigation">
      <Link href="/" onClick={onNavigate} className="app-brand">
        <WrenlyMark className="size-6" />
        <span>wrenly</span>
      </Link>
      <div className="app-nav-links">
        <Link
          href="/"
          onClick={onNavigate}
          aria-current={pathname === "/" ? "page" : undefined}
        >
          <HouseIcon />
          Home
        </Link>
        <Link
          href="/get-started"
          onClick={onNavigate}
          aria-current={pathname === "/get-started" ? "page" : undefined}
        >
          <CircleDotIcon />
          Get started
        </Link>
        <Link
          href="/projects"
          aria-current={pathname.startsWith("/projects") ? "page" : undefined}
          onClick={onNavigate}
        >
          <LayersIcon />
          Projects
        </Link>
      </div>
      {onSearchChange && (
        <label className="app-rail-search">
          <SearchIcon aria-hidden="true" />
          <span className="sr-only">Search projects in navigation</span>
          <input
            ref={searchInputRef}
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search projects…"
          />
        </label>
      )}
      <div className="app-rail-heading">
        <h2>{search.trim() ? "Search results" : "Recent projects"}</h2>
        <span>{isPending || isError ? "—" : projects.length}</span>
      </div>
      <div className="app-project-filters" aria-label="Project filters">
        {FILTERS.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="app-project-list">
        {isPending && (
          <p role="status" className="app-rail-notice">
            Loading projects…
          </p>
        )}
        {isError && (
          <div role="alert" className="app-rail-notice">
            <p>{error.message}</p>
            {error instanceof ProjectListError && error.status === 401 ? (
              <Link href="/sign-in" onClick={onNavigate}>
                Sign in again
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => {
                  void refetch();
                }}
              >
                Try again
              </button>
            )}
          </div>
        )}
        {!isPending && !isError && visible.length === 0 && (
          <p className="app-rail-notice">
            {search.trim()
              ? "No matching projects. Try another name."
              : filter !== "all"
                ? "No projects match this filter."
                : "Your first project starts here."}
          </p>
        )}
        {!isError &&
          visible.map((project, index) => {
            const status = project.latestBuild?.status,
              label = LABELS[status ?? ""] ?? "Not built yet";
            return (
              <div
                key={project.id}
                className="app-project-row"
                data-continuation={
                  matching.length > SIDEBAR_PROJECT_LIMIT &&
                  index === visible.length - 1
                }
                data-active={pathname === `/p/${project.id}`}
              >
                <Link
                  href={`/p/${project.id}`}
                  onClick={onNavigate}
                  aria-current={
                    pathname === `/p/${project.id}` ? "page" : undefined
                  }
                  title={project.name}
                >
                  <span
                    className="app-project-dot"
                    data-status={status}
                    aria-hidden="true"
                  />
                  <span className="app-project-label">
                    <span>{project.name}</span>
                    <span>
                      {project.accessMode && project.accessMode !== "private"
                        ? "Shared · "
                        : ""}
                      {label} · {relativeTime(project.updatedAt)}
                    </span>
                  </span>
                </Link>
                {project.latestBuild?.deployedUrl && (
                  <a
                    href={project.latestBuild.deployedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="app-project-live"
                    aria-label={`Open deployed app for ${project.name}`}
                  >
                    <ArrowUpRightIcon />
                  </a>
                )}
              </div>
            );
          })}
        {!isPending && !isError && matching.length > SIDEBAR_PROJECT_LIMIT && (
          <div className="app-project-continuation" aria-hidden="true" />
        )}

      </div>
      <div className="app-rail-setup">
        <SetupProgressCard />
      </div>
      <div className="app-rail-footer">
        <Link
          href="/settings/connections"
          className="app-rail-connections"
          onClick={onNavigate}
          aria-current={
            pathname === "/settings/connections" ? "page" : undefined
          }
        >
          <span>Connections</span>
          <span className="connector-icon-stack" aria-hidden="true">
            {["figma", "github", "coolify"].map((name) => (
              <span key={name}>
                <span
                  className="connector-brand"
                  style={{ backgroundImage: `url(/connectors/${name}.svg)` }}
                />
              </span>
            ))}
          </span>
        </Link>
        <Link
          href="/settings"
          onClick={onNavigate}
          aria-current={
            pathname.startsWith("/settings") &&
            pathname !== "/settings/connections"
              ? "page"
              : undefined
          }
        >
          <SettingsIcon />
          Settings
        </Link>
        <p>Self-hosted Wrenly</p>
      </div>
    </nav>
  );
}
