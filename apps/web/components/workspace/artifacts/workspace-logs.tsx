"use client";
// Displays recorded output from existing snapshots; never starts or retries work.
import { useEffect, useRef, useState } from "react";
import {
  searchDiagnosticText,
  type DiagnosticSource,
  type DiagnosticSourceId,
} from "@/lib/diagnostics/workspace-diagnostics";
const FOLLOW_DISTANCE_PX = 80;
const MAX_SEARCH_CHARACTERS = 256;
const FILTERS = [
  { id: "all", label: "All sources" },
  { id: "build", label: "Build" },
  { id: "preview", label: "Preview" },
  { id: "publishing", label: "Publishing" },
] as const;

export function WorkspaceLogs({
  revisionId,
  sources,
}: {
  revisionId?: string;
  sources: DiagnosticSource[];
}): React.JSX.Element {
  const [filter, setFilter] = useState<DiagnosticSourceId | "all">("build");
  const [search, setSearch] = useState("");
  const [following, setFollowing] = useState(true);
  const follow = useRef(true);
  const output = useRef<HTMLDivElement>(null);
  const visible = sources
    .filter((item) => filter === "all" || item.id === filter)
    .map((item) => ({
      ...item,
      result: searchDiagnosticText(item.text, search),
    }));
  const matches = visible.reduce(
    (count, item) => count + item.result.lineCount,
    0,
  );
  const operations = sources
    .map((item) => `${item.id}:${item.operationId ?? ""}`)
    .join("|");
  const content = visible
    .map((item) => `${item.status}:${item.result.text}`)
    .join("\n");
  useEffect(() => {
    if (output.current && follow.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [content, operations]);
  if (!revisionId)
    return (
      <div className="workspace-logs-empty">
        Select a revision to inspect its diagnostics.
      </div>
    );
  return (
    <section className="workspace-logs" aria-label="Revision diagnostics">
      <div className="workspace-log-tools">
        <div
          className="workspace-log-filters"
          role="group"
          aria-label="Diagnostic source"
        >
          {FILTERS.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-label={item.label}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              <strong>{item.label}</strong>
              <small>
                {item.id === "all"
                  ? ""
                  : (sources.find((source) => source.id === item.id)?.status ??
                    "No activity")}
              </small>
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Search diagnostic output"
          placeholder="Find in output…"
          value={search}
          maxLength={MAX_SEARCH_CHARACTERS}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search && (
          <button
            type="button"
            className="workspace-log-clear"
            onClick={() => setSearch("")}
          >
            Clear search
          </button>
        )}
      </div>
      <div className="workspace-log-meta">
        <span>
          Revision {revisionId.slice(0, 8)} · {matches}{" "}
          {search.trim() ? "matching " : ""}diagnostic lines
        </span>
        <button
          type="button"
          aria-pressed={following}
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            if (output.current)
              output.current.scrollTop = output.current.scrollHeight;
          }}
        >
          {following ? "Following latest" : "Follow latest"}
        </button>
      </div>
      <div
        className="workspace-log-output"
        ref={output}
        tabIndex={0}
        aria-label="Diagnostic output"
        onScroll={(event) => {
          const element = event.currentTarget;
          const nearBottom =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            FOLLOW_DISTANCE_PX;
          // Filtering or a source error can shrink the scroll range; only an explicit
          // Follow latest action resumes reading once the user has scrolled away.
          if (!nearBottom) {
            follow.current = false;
            setFollowing(false);
          }
        }}
      >
        {!matches && (
          <p className="workspace-logs-empty" role="status">
            No diagnostic lines match this search.
          </p>
        )}
        {visible
          .filter((item) => item.result.lineCount > 0 || item.truncated)
          .map((item) => (
            <section
              className="workspace-log-source"
              key={item.id}
              data-log-source={item.id}
            >
              <header>
                <h3>{item.label}</h3>
                <span>
                  {item.statusOnly ? "Status only · " : ""}
                  {item.status}
                  {item.operationId ? ` · ${item.operationId.slice(0, 8)}` : ""}
                </span>
              </header>
              {item.truncated && (
                <p className="workspace-log-notice">
                  Showing the latest 256,000 characters. Earlier output is
                  omitted from this view.
                </p>
              )}
              <pre>
                {item.result.text.split("\n").map((line, index, lines) => (
                  <span
                    key={index}
                    className={`workspace-log-line${/\b(error|failed|failure)\b/i.test(line) ? " is-error" : /\b(warn|warning)\b/i.test(line) ? " is-warning" : ""}`}
                    data-line={index + 1}
                  >
                    {line}
                    {index < lines.length - 1 ? "\n" : ""}
                  </span>
                ))}
              </pre>
              {item.statusOnly && (
                <p className="workspace-log-notice">
                  Raw deployment runtime logs are not collected here. Open the
                  application in Coolify to inspect its running server.
                </p>
              )}
            </section>
          ))}
      </div>
    </section>
  );
}
