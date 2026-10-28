"use client";
// This view only reads saved
// attempts; opening a project never admits a new deployment.
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSetupSummary } from "@/lib/onboarding/setup-summary";
import { apiFetch } from "@/lib/api";
interface DeploymentRecord {
  id: string;
  projectId: string;
  projectName: string;
  buildId: string;
  stack: string;
  status: string;
  createdAt: string;
  url: string | null;
}
interface HistoryPage {
  deployments: DeploymentRecord[];
  nextOffset: number | null;
}
const HISTORY_REFRESH_MS = 5000;
function parseHistory(raw: unknown): HistoryPage {
  if (!raw || typeof raw !== "object")
    throw new Error("Deployment history is unreadable.");
  const value = raw as Record<string, unknown>;
  if (
    !Array.isArray(value.deployments) ||
    value.deployments.length > 24 ||
    !(
      value.nextOffset === null ||
      (typeof value.nextOffset === "number" &&
        Number.isInteger(value.nextOffset) &&
        value.nextOffset >= 0 &&
        value.nextOffset <= 10000)
    )
  )
    throw new Error("Deployment history is incomplete.");
  const deployments = value.deployments.map(
    (entry: unknown): DeploymentRecord => {
      if (!entry || typeof entry !== "object")
        throw new Error("Invalid deployment record.");
      const row = entry as Record<string, unknown>;
      if (
        !["id", "projectId", "buildId"].every(
          (key) =>
            typeof row[key] === "string" &&
            /^[0-9a-f-]{36}$/i.test(row[key] as string),
        ) ||
        !["projectName", "stack", "status", "createdAt"].every(
          (key) => typeof row[key] === "string",
        ) ||
        !Number.isFinite(Date.parse(row.createdAt as string))
      )
        throw new Error("Invalid deployment record.");
      let url: string | null = null;
      if (typeof row.url === "string") {
        const parsed = new URL(row.url);
        if (
          ["http:", "https:"].includes(parsed.protocol) &&
          !parsed.username &&
          !parsed.password
        )
          url = parsed.href;
      }
      return {
        id: row.id as string,
        projectId: row.projectId as string,
        buildId: row.buildId as string,
        projectName: row.projectName as string,
        stack: row.stack as string,
        status: row.status as string,
        createdAt: row.createdAt as string,
        url,
      };
    },
  );
  return { deployments, nextOffset: value.nextOffset as number | null };
}
export default function DeploymentsPage(): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const summary = useSetupSummary();
  const history = useQuery({
    queryKey: ["deployment-history", offset],
    refetchInterval: HISTORY_REFRESH_MS,
    queryFn: async ({ signal }): Promise<HistoryPage> => {
      try {
        const response = await apiFetch(`/api/deployments?offset=${offset}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        });
        if (!response.ok)
          throw new Error(
            "Deployment history could not be loaded. Your access may have changed.",
          );
        return parseHistory(await response.json());
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error("Deployment history is unavailable.");
      }
    },
  });
  return (
    <section className="projects-page deployments-page">
      <header className="projects-heading">
        <div>
          <p className="eyebrow">From your workspace to the world</p>
          <h1>Deployments</h1>
          <p>Publishing attempts for projects you can access.</p>
        </div>
        <Link href="/settings/connections">Connections ↗</Link>
      </header>
      <nav className="projects-collection-nav" aria-label="Project collections">
        <Link href="/projects">Projects</Link>
        <Link href="/projects/drafts">Drafts</Link>
        <Link href="/projects/deployments" aria-current="page">
          Deployments
        </Link>
      </nav>
      {summary.data?.publishing === "operator-setup" && !summary.isError ? (
        <p className="deployment-config-note">
          New publishing is disabled for this instance. Your saved deployment
          history remains available.
        </p>
      ) : null}
      {history.isError ? (
        <div role="alert">
          <p>{history.error.message}</p>
          <button onClick={() => void history.refetch()}>Try again</button>
        </div>
      ) : history.isPending ? (
        <p role="status">Loading deployments…</p>
      ) : (
        <>
          {!history.data.deployments.length ? (
            <div className="connection-card">
              <div>
                <h2>
                  {offset ? "No more deployments" : "Nothing published yet"}
                </h2>
                <p>
                  Publish a validated revision from a project workspace.
                  Attempts will appear here even when publishing is later
                  disabled.
                </p>
              </div>
            </div>
          ) : (
            <div className="deployment-history-list">
              {history.data.deployments.map((item) => (
                <article className="deployment-history-row" key={item.id}>
                  <div>
                    <Link
                      className="deployment-project"
                      href={`/p/${item.projectId}?build=${item.buildId}`}
                    >
                      {item.projectName}
                    </Link>
                    <p>
                      {item.stack === "nextjs"
                        ? "Next.js"
                        : item.stack === "laravel"
                          ? "Laravel"
                          : item.stack}{" "}
                      · Revision {item.buildId.slice(0, 8)}
                    </p>
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <div className="deployment-row-actions">
                    <span className="connection-state">{item.status}</span>
                    <Link href={`/p/${item.projectId}?build=${item.buildId}`}>
                      Open revision ↗
                    </Link>
                    {item.status === "success" && item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open app ↗
                      </a>
                    ) : null}
                  </div>
                  {item.status === "interrupted" ? (
                    <p className="deployment-attention">
                      Execution could not be confirmed. Open the project for
                      recovery details; another attempt is never started
                      automatically.
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </>
      )}
      <div className="draft-pagination">
        <button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 24))}
        >
          Previous
        </button>
        <span>Page {Math.floor(offset / 24) + 1}</span>
        <button
          disabled={history.isError || !history.data?.nextOffset}
          onClick={() => {
            if (history.data?.nextOffset) setOffset(history.data.nextOffset);
          }}
        >
          Next
        </button>
      </div>
    </section>
  );
}
