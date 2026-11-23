"use client";
import styles from "@/components/settings/connections/connections.module.css";
import { Suspense, useState } from "react";
import { GitHubConnectionCard } from "@/components/settings/connections/github-connection-card";
import { ProductionHostSetup } from "@/components/settings/production-databases/production-host-setup";
import { ProductionServerSetup } from "@/components/settings/production-databases/production-server-setup";
import { authClient } from "@/lib/auth/auth-client";
import { DocumentationLink } from "@/components/documentation-link";
// Configuration is not health.
import Link from "next/link";
import {
  BoxIcon,
  PenToolIcon,
  PlugIcon,
  GitBranchIcon,
  ArrowUpRightIcon,
  ServerIcon,
  FolderKanbanIcon,
} from "lucide-react";
import { useSetupSummary } from "@/lib/onboarding/setup-summary";

type ConnectionTabId = "source" | "publishing" | "apps";

const CONNECTION_TABS: Array<{
  id: ConnectionTabId;
  label: string;
  icon: typeof GitBranchIcon;
}> = [
  { id: "source", label: "Source Control", icon: GitBranchIcon },
  { id: "publishing", label: "Publishing & Deploy", icon: ServerIcon },
  { id: "apps", label: "External Apps", icon: PlugIcon },
];

export default function ConnectionsPage(): React.JSX.Element {
  const summary = useSetupSummary();
  const [activeTab, setActiveTab] = useState<ConnectionTabId>("source");
  const publishingEnabled = summary.data?.publishing === "enabled";
  const { data: session } = authClient.useSession();
  return (
    <section className={`connections-page ${styles.page}`}>
      <header>
        <p className="eyebrow">Your infrastructure, connected</p>
        <h1>Connections</h1>
        <p>
          Manage source control access, repository import size limits,
          self-hosted publishing targets, and upcoming external app tools.
        </p>
      </header>
      {summary.isError ? (
        <div role="alert" className={styles.alertError}>
          <p>Connection configuration could not be checked.</p>
          <button onClick={() => void summary.refetch()}>Try again</button>
        </div>
      ) : null}
      <div className={styles.tabs} role="tablist" aria-label="Connection groups">
        {CONNECTION_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`connections-tab-${id}`}
            aria-controls={`connections-panel-${id}`}
            aria-selected={activeTab === id}
            className={styles.tab}
            onClick={() => setActiveTab(id)}
          >
            <Icon size={15} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {activeTab === "source" ? (
        <div
          role="tabpanel"
          id="connections-panel-source"
          aria-labelledby="connections-tab-source"
          className={styles.tabPanel}
        >
          <div className={styles.sectionTitle}>
            <div>
              <h2>Active source connections</h2>
              <p>
                Connect repositories, review security or runtime exclusions, and
                adjust instance import size limits.
              </p>
            </div>
            <span className={styles.badgeActive}>
              <span className={styles.dotActive} aria-hidden="true" />
              GitHub supported
            </span>
          </div>

          <Suspense fallback={<p>Loading GitHub connection…</p>}>
            <GitHubConnectionCard />
          </Suspense>

          <section className={styles.plannedSection} aria-label="Planned source hosts">
            <div className={styles.plannedHeading}>
              <span>Planned · Not yet available</span>
              <p>Additional Git providers are on the roadmap and not configurable yet.</p>
            </div>
            <article className={styles.plannedCard}>
              <GitBranchIcon size={22} aria-hidden="true" />
              <div>
                <div className={styles.cardHeaderRow}>
                  <h2>More source hosts</h2>
                  <span className={styles.badgePlanned}>Coming soon</span>
                </div>
                <p>
                  GitLab and additional self-hosted Git hosts are planned for a
                  future release. Use GitHub above for imports and push reviews.
                </p>
              </div>
            </article>
          </section>
        </div>
      ) : null}

      {activeTab === "publishing" ? (
        <div
          role="tabpanel"
          id="connections-panel-publishing"
          aria-labelledby="connections-tab-publishing"
          className={styles.tabPanel}
        >
          <div className={styles.sectionTitle}>
            <div>
              <h2>Available now · Self-hosted publishing pipeline</h2>
              <p>
                These three services work together on your server to store
                source artifacts and publish validated images.
              </p>
            </div>
            {summary.isError ? (
              <span className={styles.badgeWarning}>Status unavailable</span>
            ) : summary.isPending ? (
              <span className="connection-state">Checking status…</span>
            ) : publishingEnabled ? (
              <span className={styles.badgeActive}>
                <span className={styles.dotActive} aria-hidden="true" />
                Publishing enabled
              </span>
            ) : (
              <span className={styles.badgeWarning}>
                Not configured on server
              </span>
            )}
          </div>

          <div className="connection-roadmap-grid">
            <article className="connection-card">
              <GitBranchIcon size={24} aria-hidden="true" />
              <div>
                <div className={styles.cardHeaderRow}>
                  <h2>Source control · Gitea</h2>
                  <span className={publishingEnabled ? styles.badgeActive : styles.badgeAvailable}>
                    {publishingEnabled ? "Connected · Env" : "Server config"}
                  </span>
                </div>
                <p>
                  Publishing saves your generated source in a private Gitea
                  repository. Your app&apos;s code and revisions stay separate
                  from its running deployment.
                </p>
                <DocumentationLink guide="guides/publishing-setup">
                  Set up private source →
                </DocumentationLink>
              </div>
            </article>

            <article className="connection-card">
              <BoxIcon size={24} aria-hidden="true" />
              <div>
                <div className={styles.cardHeaderRow}>
                  <h2>Private image registry</h2>
                  <span className={publishingEnabled ? styles.badgeActive : styles.badgeAvailable}>
                    {publishingEnabled ? "Connected · Env" : "Server config"}
                  </span>
                </div>
                <p>
                  Stores the runnable image built in Wrenly&apos;s sandbox. Your
                  deployment server pulls that exact image rather than
                  rebuilding source.
                </p>
                <DocumentationLink guide="guides/publishing-setup">
                  Set up the registry →
                </DocumentationLink>
              </div>
            </article>
          </div>

          <article className="connection-card">
            <BoxIcon size={24} aria-hidden="true" />
            <div>
              <div className={styles.cardHeaderRow}>
                <h2>Deployments · Coolify</h2>
                <span
                  className={
                    summary.isError
                      ? styles.badgeWarning
                      : summary.isPending
                        ? "connection-state"
                        : publishingEnabled
                          ? styles.badgeActive
                          : styles.badgeWarning
                  }
                >
                  {summary.isError
                    ? "Status unavailable"
                    : summary.isPending
                      ? "Checking configuration…"
                      : publishingEnabled
                        ? "Publishing enabled"
                        : "Not configured"}
                </span>
              </div>
              <p>
                Publish a validated application image through your private
                registry to infrastructure you control.
              </p>
              <p className="connection-note">
                Configuration status reflects server environment variables and
                does not probe remote reachability. Check deployment history for
                actual publishing outcomes.
              </p>
              <Link href="/projects/deployments">
                View deployments <ArrowUpRightIcon size={14} aria-hidden="true" />
              </Link>
              <details>
                <summary>How publishing is configured</summary>
                <p>
                  The instance owner connects Gitea, a private image registry,
                  and Coolify on the server host. Credentials remain outside the
                  browser and are never displayed on this page.
                </p>
                <div className="connection-help-links">
                  <DocumentationLink guide="guides/private-publishing">
                    Publishing setup guide →
                  </DocumentationLink>
                  <Link href="/get-started">Review instance setup</Link>
                </div>
              </details>
            </div>
          </article>

          {summary.data?.role === "owner" && session?.user.id ? (
            <>
              <ProductionServerSetup actorId={session.user.id} />
              <ProductionHostSetup actorId={session.user.id} />
            </>
          ) : null}

          <section className={styles.plannedSection} aria-label="Planned deployers">
            <div className={styles.plannedHeading}>
              <span>Planned · Not yet available</span>
              <p>Future deployment adapters will appear here once implemented.</p>
            </div>
            <article className={styles.plannedCard}>
              <BoxIcon size={22} aria-hidden="true" />
              <div>
                <div className={styles.cardHeaderRow}>
                  <h2>Additional deployers</h2>
                  <span className={styles.badgePlanned}>Coming soon</span>
                </div>
                <p>
                  Additional self-hosted delivery targets are planned for later
                  releases. Coolify via private registry above is the supported
                  deployer today.
                </p>
              </div>
            </article>
          </section>
        </div>
      ) : null}

      {activeTab === "apps" ? (
        <div
          role="tabpanel"
          id="connections-panel-apps"
          aria-labelledby="connections-tab-apps"
          className={styles.tabPanel}
        >
          <div className={styles.sectionTitle}>
            <div>
              <h2>External app connectors</h2>
              <p>
                Third-party design tools, project workflows, and MCP app
                integrations you will be able to authorize for Wrenly.
              </p>
            </div>
            <span className={styles.badgePlanned}>None active yet</span>
          </div>

          <section className={styles.plannedSection} aria-label="Planned external apps">
            <div className={styles.plannedHeading}>
              <span>Planned · Coming soon</span>
              <p>
                External app integrations are not implemented yet and are shown
                here so you can see what is planned.
              </p>
            </div>
            <div className="connection-roadmap-grid">
              <article className={styles.plannedCard}>
                <PenToolIcon size={22} aria-hidden="true" />
                <div>
                  <div className={styles.cardHeaderRow}>
                    <h3>Figma</h3>
                    <span className={styles.badgePlanned}>Coming soon</span>
                  </div>
                  <p>
                    Import design tokens, components, and screen context through
                    Figma&apos;s official MCP server with explicit user consent.
                  </p>
                </div>
              </article>
              <article className={styles.plannedCard}>
                <PlugIcon size={22} aria-hidden="true" />
                <div>
                  <div className={styles.cardHeaderRow}>
                    <h3>MCP connectors</h3>
                    <span className={styles.badgePlanned}>Coming soon</span>
                  </div>
                  <p>
                    Authorize approved Model Context Protocol servers to bring
                    external APIs and workspace tools into project sessions.
                  </p>
                </div>
              </article>
              <article className={styles.plannedCard}>
                <FolderKanbanIcon size={22} aria-hidden="true" />
                <div>
                  <div className={styles.cardHeaderRow}>
                    <h3>Issue &amp; project trackers</h3>
                    <span className={styles.badgePlanned}>Coming soon</span>
                  </div>
                  <p>
                    Link issue context and specifications from tools like Linear
                    or Jira directly into project planning and builds.
                  </p>
                </div>
              </article>
            </div>
          </section>

          <div className={styles.crossLinkNote}>
            <span>
              Looking for AI model providers or API keys for conversations and
              builds?
            </span>
            <Link href="/settings/providers">
              Manage providers in Settings{" "}
              <ArrowUpRightIcon size={14} aria-hidden="true" />
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}
