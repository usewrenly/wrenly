"use client";
// Browsing never admits a build.
import { useState } from "react";
import Link from "next/link";
import { ArrowUpRightIcon, SettingsIcon, PlusIcon } from "lucide-react";
import { ProjectListError, useProjects } from "@/hooks/use-projects";
import { ChoiceSelect } from "@/components/ui/choice-select";
import { StackBadge } from "@/components/shell/stack-badge";
import { StatusPill } from "@/components/shell/status-pill";
import { WrenlyMark } from "@/components/wrenly-mark";
import { stackLabel } from "@/lib/stacks";
import { relativeTime } from "@/lib/format";

const PAGE_SIZE = 24;
function safeExternalUrl(value: string | null | undefined): string | null {
  try {
    if (!value) return null;
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function ProjectsCollection(): React.JSX.Element {
  const [archived, setArchived] = useState(false);
  const {
    data: projects = [],
    isPending,
    error,
    refetch,
  } = useProjects(archived);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("all");
  const [framework, setFramework] = useState("all");
  const [sort, setSort] = useState("updated");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const change = (setter: (value: string) => void, value: string): void => {
    setter(value);
    setLimit(PAGE_SIZE);
  };
  const clear = (): void => {
    setSearch("");
    setStatus("all");
    setScope("all");
    setFramework("all");
    setSort("updated");
    setLimit(PAGE_SIZE);
  };
  const filtered = projects
    .filter((project) => {
      const buildStatus = project.latestBuild?.status ?? "idle";
      return (
        `${project.name} ${project.description ?? ""}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()) &&
        (scope === "all" ||
          (scope === "owned" && project.owned !== false) ||
          (scope === "shared" && project.owned === false)) &&
        (framework === "all" || project.stack === framework) &&
        (status === "all" ||
          (status === "active"
            ? ["pending", "generating", "building"].includes(buildStatus)
            : buildStatus === status))
      );
    })
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
        : b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  return (
    <div className="projects-page">
      <header className="projects-heading">
        <div>
          <p className="home-eyebrow">Your ideas, taking shape</p>
          <h1>Projects</h1>
          <p>A place for everything you’re building.</p>
        </div>
        <Link className="projects-new" href="/#new-project">
          <PlusIcon size={16} aria-hidden="true" />
          New project
        </Link>
      </header>
      <nav className="projects-collection-nav" aria-label="Project collections">
        <Link href="/projects" aria-current="page">
          Projects
        </Link>
        <Link href="/projects/drafts">Drafts</Link>
        <Link href="/projects/deployments">Deployments</Link>
      </nav>
      <div
        className="projects-archive-filter"
        role="group"
        aria-label="Project lifecycle"
      >
        <button
          type="button"
          aria-pressed={!archived}
          onClick={() => {
            setArchived(false);
            setLimit(PAGE_SIZE);
          }}
        >
          Active
        </button>
        <button
          type="button"
          aria-pressed={archived}
          onClick={() => {
            setArchived(true);
            setLimit(PAGE_SIZE);
          }}
        >
          Archived
        </button>
      </div>
      <div className="projects-tools">
        <ChoiceSelect
          label="Project ownership"
          value={scope}
          onChange={(value) => change(setScope, value)}
          options={[
            { value: "all", label: "All projects" },
            { value: "owned", label: "Owned by you" },
            { value: "shared", label: "Shared with you" },
          ]}
        />
        <input
          type="search"
          aria-label="Search your projects"
          placeholder="Search names or descriptions…"
          value={search}
          onChange={(event) => change(setSearch, event.target.value)}
        />
        <ChoiceSelect
          label="Filter projects"
          value={status}
          onChange={(value) => change(setStatus, value)}
          options={[
            { value: "all", label: "All builds" },
            { value: "active", label: "In progress" },
            { value: "success", label: "Built" },
            { value: "failed", label: "Failed" },
            { value: "idle", label: "No build yet" },
          ]}
        />
        <ChoiceSelect
          label="Filter framework"
          value={framework}
          onChange={(value) => change(setFramework, value)}
          options={[
            { value: "all", label: "All frameworks" },
            ...[
              ...new Set([
                "nextjs",
                "laravel",
                ...projects.map((project) => project.stack),
              ]),
            ]
              .sort()
              .map((stack) => ({ value: stack, label: stackLabel(stack) })),
          ]}
        />
        <ChoiceSelect
          label="Sort projects"
          value={sort}
          onChange={(value) => change(setSort, value)}
          options={[
            { value: "updated", label: "Recently updated" },
            { value: "name", label: "Name A–Z" },
          ]}
        />
      </div>
      {isPending ? (
        <p className="home-empty" role="status">
          Loading your projects…
        </p>
      ) : error ? (
        <div className="home-empty" role="alert">
          <p>{error.message}</p>
          {error instanceof ProjectListError && error.status === 401 ? (
            <Link href="/sign-in">Sign in again</Link>
          ) : (
            <button onClick={() => void refetch()}>Try again</button>
          )}
        </div>
      ) : projects.length === 0 ? (
        <div className="home-empty">
          <h2>
            {archived ? "No archived projects" : "Your next idea belongs here"}
          </h2>
          <p>
            {archived
              ? "Archived projects will appear here. Open their settings to restore them."
              : "Start a project from Home. Its files and history will stay together."}
          </p>
          <Link href="/#new-project">Describe your first app</Link>
        </div>
      ) : (
        <>
          <p className="projects-count" role="status">
            {filtered.length} of {projects.length} projects
          </p>
          {filtered.length === 0 ? (
            <div className="home-empty">
              <p>No projects match these filters.</p>
              <button onClick={clear}>Clear filters</button>
            </div>
          ) : (
            <div className="projects-grid">
              {filtered.slice(0, limit).map((project) => {
                const deployedUrl = safeExternalUrl(
                  project.latestBuild?.deployedUrl,
                );
                return (
                  <article className="project-card" key={project.id}>
                    <Link
                      className="project-card-main"
                      href={`/p/${project.id}`}
                    >
                      <div className="project-card-top">
                        <StackBadge stack={project.stack} />
                        <ArrowUpRightIcon size={17} aria-hidden="true" />
                      </div>
                      <h2>{project.name}</h2>
                      <span className="text-xs text-[var(--color-text-3)]">
                        {project.accessMode && project.accessMode !== "private"
                          ? "Shared"
                          : "Private"}
                        {project.owned === false ? " · Shared with you" : ""}
                      </span>
                      <p className="project-card-description">
                        {project.description ||
                          "An idea in progress. And it’s all yours."}
                      </p>
                      <div className="project-card-art" aria-hidden="true">
                        <WrenlyMark />
                      </div>
                      <div className="project-card-plate">
                        <span>Updated {relativeTime(project.updatedAt)}</span>
                        {project.latestBuild ? (
                          <StatusPill
                            status={project.latestBuild.status}
                            animate={false}
                          />
                        ) : (
                          <span>No build yet</span>
                        )}
                      </div>
                    </Link>
                    <footer>
                      <Link
                        href={`/p/${project.id}/settings`}
                        aria-label={`Settings for ${project.name}`}
                      >
                        <SettingsIcon size={14} aria-hidden="true" />
                        Settings
                      </Link>
                      {deployedUrl && (
                        <a
                          href={deployedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Open deployed app for ${project.name}`}
                        >
                          Deployed app
                          <ArrowUpRightIcon size={14} aria-hidden="true" />
                        </a>
                      )}
                    </footer>
                  </article>
                );
              })}
            </div>
          )}
          {filtered.length > limit && (
            <button
              className="projects-more"
              onClick={() => setLimit((current) => current + PAGE_SIZE)}
            >
              Show more ({filtered.length - limit} remaining)
            </button>
          )}
        </>
      )}
    </div>
  );
}
