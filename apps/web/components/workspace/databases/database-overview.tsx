"use client";
/** Displays verified resource metadata; parent-owned callbacks preserve explicit confirmation and recovery. */
import { DocumentationLink } from "@/components/documentation-link";
import { useState } from "react";
import { DatabaseIcon, ShieldCheckIcon, ArrowUpRightIcon, RefreshCwIcon } from "lucide-react";
import { DatabaseResourceStatus } from "@wrenly/db/app-database-resource-contract";
import "./database-overview.css";

type Environment = "development" | "production";
export type DatabaseOverviewState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "loaded"; projectId: string; value: unknown };
interface DatabaseOverviewProps {
  projectId: string;
  state: DatabaseOverviewState;
  onReload: () => void;
  onCreate?: (environment: Environment) => void;
  onManage?: (resourceId: string) => void;
  onLifecycle?: (resourceId: string, action: "start" | "stop") => void;
  onOpen?: (resourceId: string, view: "rows" | "schema") => void;
}
const STATUS = { provisioning: "Setting up", ready: "Ready", stopped: "Stopped", failed: "Needs attention", recovery_required: "Review required" } as const;
const OPERATIONS: Record<DatabaseResourceStatus["operations"][number]["kind"], string> = {
  create: "Create database", start: "Start database", stop: "Stop database", backup: "Back up database",
  migrate: "Apply reviewed changes", read: "Inspect database", "recover-read": "Resolve inspection",
  "recover-before-effect": "Resolve interrupted work", "recover-runtime-state": "Check runtime state",
  "validate-application": "Validate application", "recover-validation": "Resolve validation",
};
const OUTCOMES = { queued: "Queued", running: "In progress", success: "Completed", failed: "Failed", interrupted: "Needs review" } as const;

/** Loading or invalid data never falls back to a previously viewed project's resource. */
export function DatabaseOverview(props: DatabaseOverviewProps): React.JSX.Element {
  if (props.state.status === "loading") return <section className="project-database" aria-busy="true">
    <p role="status">Loading database status…</p>
  </section>;
  const parsed = props.state.status === "loaded" && props.state.projectId === props.projectId
    ? DatabaseResourceStatus.safeParse(props.state.value) : null;
  if (!parsed?.success || parsed.data.resources.some((resource) => resource.projectId !== props.projectId))
    return <section className="project-database"><div className="database-empty" role="status">
      <DatabaseIcon aria-hidden="true" /><h2>Database status is unavailable.</h2>
      <p>Reload to check this project’s current resources and access.</p>
      <button type="button" onClick={props.onReload}><RefreshCwIcon aria-hidden="true" /> Reload status</button>
    </div></section>;
  return <DatabaseOverviewContent key={props.projectId} {...props} status={parsed.data} />;
}

function DatabaseOverviewContent({ status, onReload, onCreate, onManage, onLifecycle, onOpen }: DatabaseOverviewProps & {
  status: DatabaseResourceStatus;
}): React.JSX.Element {
  const [environment, setEnvironment] = useState<Environment>("development");
  const resource = status.resources.find((item) => item.environment === environment);
  const operations = resource ? status.operations.filter((item) => item.databaseId === resource.id) : [];
  const canBrowseRows = environment === "development" && status.capabilities.developmentRows;
  return <section className="project-database" aria-label="Project database">
    <header className="database-heading"><div><p className="home-eyebrow">Project resources</p>
      <h1>Database <span className="database-experimental-badge">Experimental</span></h1><p>Development data for your app. Production databases and database-backed publishing are not available yet.</p><div className="database-help-link"><DocumentationLink guide="guides/app-databases">How databases work →</DocumentationLink></div></div>
      <button type="button" className="database-refresh" onClick={onReload} aria-label="Reload database status">
        <RefreshCwIcon aria-hidden="true" />
      </button></header>
    <div className="database-toolbar"><div className="database-environments" role="group" aria-label="Database environment">
      {(["development", "production"] as const).map((value) => <button type="button" key={value}
        aria-pressed={environment === value} onClick={() => setEnvironment(value)}>
        {value === "development" ? "Development" : "Production"}
      </button>)}
    </div><span>Separate data. Separate credentials.</span></div>
    {!resource ? <div className="database-empty"><DatabaseIcon aria-hidden="true" />
      <p className="home-eyebrow">{environment === "development" ? "Development" : "Production"} environment</p>
      <h2>{environment === "development" ? "Give your app a database." : "Keep production separate."}</h2>
      <p>{environment === "development" ? "Set up PostgreSQL for this project. Connection credentials stay on your instance and out of your code."
        : "Production uses its own database and reviewed schema. Development data is never copied automatically."}</p>
      {status.capabilities.manage && onCreate ? <button type="button" className="database-primary" onClick={() => onCreate(environment)}>
        {environment === "development" ? "Set up Development" : "Set up Production"}<ArrowUpRightIcon aria-hidden="true" />
      </button> : <p className="database-muted">{status.capabilities.manage ? "Database setup is not enabled on this instance." : "The project owner can set up this environment."}</p>}
    </div> : <>
      <article className="database-resource"><div className="database-resource-heading"><div className="database-resource-title">
        <span className="database-symbol"><DatabaseIcon aria-hidden="true" /></span><div><h2>PostgreSQL</h2>
          <p>{resource.provider === "local" ? "Managed on your instance" : "Private database resource"}</p></div></div>
        <span className="database-resource-status" data-status={resource.status}>{STATUS[resource.status]}</span>
      </div><dl className="database-facts"><div><dt>Environment</dt><dd>{environment === "development" ? "Development" : "Production"}</dd></div>
        <div><dt>Schema fingerprint</dt><dd>{resource.schemaDigest ? <code title={resource.schemaDigest}>{resource.schemaDigest.slice(0, 12)}</code> : "Not recorded yet"}</dd></div>
        <div><dt>Your data access</dt><dd>{canBrowseRows ? "Read-only rows and schema" : "Schema inspection"}</dd></div></dl>
      {resource.status === "recovery_required" || resource.status === "failed" ? <p className="database-attention" role="status">
        {resource.status === "recovery_required" ? "An earlier operation needs review. Your saved data and operation history are preserved."
          : "This resource needs attention. Review its saved operation before trying again."}
      </p> : null}
      <div className="database-resource-actions"><span><ShieldCheckIcon aria-hidden="true" /> Credentials stay private</span><div>
        {status.capabilities.manage && onLifecycle && ["ready", "stopped"].includes(resource.status) ? <button type="button"
          disabled={operations.some(operation => ["queued", "running", "interrupted"].includes(operation.status))}
          onClick={() => onLifecycle(resource.id, resource.status === "stopped" ? "start" : "stop")}>
          {resource.status === "stopped" ? "Start database" : "Stop database"}
        </button> : null}
        {status.capabilities.manage && onManage ? <button type="button" onClick={() => onManage(resource.id)}>Manage resource</button> : null}
        {onOpen ? <button type="button" className="database-primary" disabled={resource.status !== "ready"}
          onClick={() => onOpen(resource.id, canBrowseRows ? "rows" : "schema")}>
          {canBrowseRows ? "Browse data" : "Inspect schema"}<ArrowUpRightIcon aria-hidden="true" />
        </button> : null}
      </div></div></article>
      <section className="database-activity" aria-labelledby="database-activity-title"><h2 id="database-activity-title">Recent activity</h2>
        {operations.length ? <ul>{operations.map((operation) => <li key={operation.id}><span>{OPERATIONS[operation.kind]}</span>
          <span className="database-operation-status" data-status={operation.status}>{OUTCOMES[operation.status]}</span></li>)}</ul>
          : <p className="database-muted">No operations recorded for this resource.</p>}
      </section>
    </>}
  </section>;
}
