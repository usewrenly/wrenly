"use client";
/** Explicit read-only table/schema selection; application text never becomes HTML or an executable link. */
import { useState } from "react";
import { ArrowLeftIcon, Table2Icon, KeyRoundIcon } from "lucide-react";
import type { DatabaseResourceStatus } from "@wrenly/db/app-database-resource-contract";
import { useDatabaseView } from "@/hooks/use-database-view";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
type Resource = DatabaseResourceStatus["resources"][number];

/** Parent keys this component by project/resource/revision, so changing any of them removes prior rows. */
export function DatabaseViewer({ projectId, resource, capabilities, initialView, onClose }: {
  projectId: string; resource: Resource; capabilities: DatabaseResourceStatus["capabilities"];
  initialView: "rows" | "schema"; onClose: () => void;
}): React.JSX.Element {
  const production = resource.environment === "production";
  const canReadRows = production ? capabilities.productionRows : capabilities.developmentRows;
  const [mode, setMode] = useState<"rows" | "schema">(!production && canReadRows ? initialView : "schema");
  const [table, setTable] = useState<string | undefined>();
  const [after, setAfter] = useState<string | undefined>();
  const [confirmRows, setConfirmRows] = useState(false);
  const selection = { resourceId: resource.id, revision: resource.revision, environment: resource.environment,
    rows: mode === "rows" && Boolean(table), ...(table ? { table } : {}), ...(after ? { after } : {}) };
  const view = useDatabaseView(projectId, selection);
  const result = view.status === "loaded" ? view.result : null;
  const chooseMode = (value: "rows" | "schema"): void => {
    if (value === "rows" && !canReadRows) return;
    if (value === "rows" && production) { setConfirmRows(true); return; }
    setMode(value); setAfter(undefined);
  };
  return <section className="project-database" aria-label="Database viewer">
    <button type="button" onClick={onClose}><ArrowLeftIcon aria-hidden="true" /> Database overview</button>
    <header className="database-heading"><div><p className="home-eyebrow">{production ? "Production" : "Development"} · Read only</p>
      <h1>{table ?? "Explore your database"}</h1><p>{production ? "Real application data. Inspect with care." : "Inspect your app’s tables and schema."}</p></div></header>
    <div className="database-browser">
      <aside className="database-table-list" aria-label="Database tables"><h2>Tables</h2>
        {result?.tables.map((name) => <button type="button" key={name} aria-pressed={table === name}
          onClick={() => { setTable(name); setAfter(undefined); }}><Table2Icon aria-hidden="true" /><span>{name}</span></button>)}
        {result?.tables.length === 0 ? <p>No tables yet.</p> : null}
        {!result ? <p>{view.status === "loading" ? "Loading…" : "Reload the resource to inspect tables."}</p> : null}
      </aside>
      <div className="database-table-content"><div className="database-environments" role="group" aria-label="Table view">
        <button type="button" aria-pressed={mode === "schema"} onClick={() => chooseMode("schema")}>Schema</button>
        {canReadRows ? <button type="button" aria-pressed={mode === "rows"} onClick={() => chooseMode("rows")}>Rows</button> : null}
      </div>
      {view.status === "loading" ? <p role="status" className="database-view-message">Loading the selected view…</p>
        : view.status === "unavailable" ? <div role="status" className="database-view-message"><h2>This view is unavailable.</h2>
          <p>Your resource, schema or access may have changed. Reload its status before continuing.</p>
          <button type="button" onClick={onClose}>Return to database status</button></div>
        : !table ? <p className="database-view-message">Select a table to inspect its schema or rows.</p>
        : mode === "schema" ? <div className="database-data-scroll"><table><caption className="sr-only">{table} schema</caption>
          <thead><tr><th>Column</th><th>Type</th><th>Nullable</th></tr></thead><tbody>{result?.columns.map((column) => <tr key={column.name}>
            <td>{column.primary ? <KeyRoundIcon aria-label="Primary key" /> : null}{column.name}</td><td>{column.type}</td><td>{column.nullable ? "Yes" : "No"}</td>
          </tr>)}</tbody></table></div>
        : <><div className="database-data-scroll"><table><caption className="sr-only">{table} read-only rows</caption>
          <thead><tr>{result?.columns.map((column) => <th key={column.name}>{column.name}<small>{column.type}</small></th>)}</tr></thead>
          <tbody>{result?.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>
            {cell === null ? <span className="database-null">NULL</span> : cell === "" ? <span className="database-null">Empty</span> : cell}
          </td>)}</tr>)}</tbody></table></div>
          {result?.rows.length === 0 ? <p className="database-view-message">No rows in this view.</p> : null}
          <footer className="database-row-footer"><span>{result?.sample ? "Bounded sample · not a complete export" : "Read-only view"}. Values may be shortened.</span>
            {after ? <button type="button" onClick={() => setAfter(undefined)}>First page</button> : null}
            {result?.nextKey ? <button type="button" onClick={() => setAfter(result.nextKey ?? undefined)}>Next page</button> : null}</footer></>}
      {result?.truncatedColumns ? <p className="database-view-message">Some columns exceed the display limit.</p> : null}
      </div>
    </div>
    <Dialog open={confirmRows} onOpenChange={setConfirmRows}><DialogContent><DialogTitle>Inspect Production rows?</DialogTitle>
      <DialogDescription>These may contain real customer information. This viewer is read only. Only the project owner can open Production rows.</DialogDescription>
      <DialogFooter><Button type="button" variant="outline" onClick={() => setConfirmRows(false)}>Cancel</Button>
        <Button type="button" onClick={() => { setConfirmRows(false); setMode("rows"); setAfter(undefined); }}>Inspect rows</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
