"use client";
import { DocumentationLink } from "@/components/documentation-link";
// Configuration is not health.
import Link from "next/link";
import {
  BoxIcon,
  PenToolIcon,
  PlugIcon,
  GitBranchIcon,
  ArrowUpRightIcon,
} from "lucide-react";
import { useSetupSummary } from "@/lib/onboarding/setup-summary";
export default function ConnectionsPage(): React.JSX.Element {
  const summary = useSetupSummary();
  return (
    <section className="connections-page">
      <header>
        <p className="eyebrow">Your infrastructure, connected</p>
        <h1>Connections</h1>
        <p>
          Source control, runnable images, deployment destinations and connected tools.
        </p>
      </header>
      {summary.isError ? (
        <div role="alert">
          <p>Connection configuration could not be checked.</p>
          <button onClick={() => void summary.refetch()}>Try again</button>
        </div>
      ) : null}
      <div className="connection-roadmap-grid">
        <article className="connection-card"><GitBranchIcon size={24} aria-hidden="true" /><div>
          <h2>Source control · Gitea</h2><span className="connection-state">Publishing source provider</span>
          <p>Publishing saves your generated source in a private Gitea repository. Your app's code and revisions stay separate from its running deployment.</p>
          <DocumentationLink guide="guides/publishing-setup">Set up private source →</DocumentationLink>
        </div></article>
        <article className="connection-card"><BoxIcon size={24} aria-hidden="true" /><div>
          <h2>Private image registry</h2><span className="connection-state">Application images</span>
          <p>Stores the runnable image built in Wrenly's sandbox. Your deployment server pulls that exact image rather than rebuilding source.</p>
          <DocumentationLink guide="guides/publishing-setup">Set up the registry →</DocumentationLink>
        </div></article>
      </div>
      <article className="connection-card">
        <BoxIcon size={24} aria-hidden="true" />
        <div>
          <h2>Deployments · Coolify</h2>
          <span className="connection-state">
            {summary.isError
              ? "Status unavailable"
              : summary.isPending
                ? "Checking configuration…"
                : summary.data?.publishing === "enabled"
                  ? "Publishing enabled"
                  : "Not configured"}
          </span>
          <p>
            Publish a validated application image through your private registry
            to infrastructure you control.
          </p>
          <p className="connection-note">
            Configuration status does not check reachability. Deployment history
            shows the outcome of each actual publishing attempt.
          </p>
          <Link href="/projects/deployments">
            View deployments <ArrowUpRightIcon size={14} aria-hidden="true" />
          </Link>
          <details>
            <summary>How publishing is connected</summary>
            <p>
              The instance owner—the account created during first setup—connects
              Gitea, a private image registry and Coolify together. These credentials stay on the server; this
              page never displays them.
            </p>
            <p>
              Publishing needs a repository, a private registry and a deployment
              target. Once these services are connected, project owners can
              publish from the workspace. Browser-based publishing configuration
              is not available yet.
            </p>
            <div className="connection-help-links"><DocumentationLink guide="guides/private-publishing">
              Publishing setup guide →
            </DocumentationLink>
            <Link href="/get-started">Review instance setup</Link></div>
          </details>
        </div>
      </article>
      <article className="connection-card"><PlugIcon size={24} aria-hidden="true" /><div>
        <h2>Apps and model providers</h2><p>Connect the AI models used for conversations and builds in Settings. Project access and publishing permissions stay separate.</p>
        <Link href="/settings/models">Manage models <ArrowUpRightIcon size={14} aria-hidden="true" /></Link>
      </div></article>
      <h2 className="connections-roadmap">On the roadmap</h2>
      <div className="connection-roadmap-grid">
        {[
          {
            title: "Figma",
            icon: PenToolIcon,
            description:
              "Import design context through Figma’s official MCP server with explicit account authorization.",
          },
          {
            title: "MCP connectors",
            icon: PlugIcon,
            description:
              "Bring approved tools and project context into your workflow, with scoped permissions.",
          },
          {
            title: "GitHub & GitLab",
            icon: GitBranchIcon,
            description:
              "Planned repository connections for importing projects and pushing changes. Gitea is the current publishing source provider.",
          },
          {
            title: "More deployers",
            icon: BoxIcon,
            description:
              "Choose another delivery destination as additional integrations become available.",
          },
        ].map(({ title, icon: Icon, description }) => (
          <article className="connection-card" key={title}>
            <Icon size={22} aria-hidden="true" />
            <div>
              <span className="connection-state">Planned</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
