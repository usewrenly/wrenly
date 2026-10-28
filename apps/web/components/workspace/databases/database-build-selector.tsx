"use client";
/** A resource existing does not imply permission to use it: selecting Development is always deliberate. */
import { useQuery } from "@tanstack/react-query";
import { DatabaseIcon, ChevronDownIcon, CheckIcon } from "lucide-react";
import type { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { requestDatabaseStatus } from "@/lib/databases/requests";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Mount only after the server's complete database feature composition is enabled. */
export function DatabaseBuildSelector({
  projectId,
  actorId,
  value,
  disabled,
  onChange,
}: {
  projectId: string;
  actorId: string;
  value?: BuildDatabaseSelection;
  disabled: boolean;
  onChange: (selection: BuildDatabaseSelection | undefined) => void;
}): React.JSX.Element {
  const query = useQuery({
    queryKey: ["project-databases", actorId, projectId],
    queryFn: ({ signal }) => requestDatabaseStatus(projectId, signal),
    retry: false,
    staleTime: 0,
  });
  const status = query.data;
  const resource =
    !query.isError && status?.capabilities.developmentRows
      ? status.resources.find(
          (item) =>
            item.environment === "development" &&
            item.provider === "local" &&
            item.status === "ready" &&
            !status.operations.some(
              (operation) =>
                operation.databaseId === item.id &&
                ["queued", "running", "interrupted"].includes(operation.status),
            ),
        )
      : undefined;
  const selected =
    value &&
    resource?.id === value.resourceId &&
    resource.revision === value.resourceRevision;
  return (
    <div className="database-build-selector">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" />}
          disabled={disabled}
        >
          <DatabaseIcon size={14} aria-hidden="true" />
          {value
            ? selected
              ? "Development database"
              : "Database needs review"
            : "No database"}
          <ChevronDownIcon size={12} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onChange(undefined)}>
            No database
            {!value ? <CheckIcon size={14} aria-hidden="true" /> : null}
          </DropdownMenuItem>
          {resource ? (
            <DropdownMenuItem
              onClick={() =>
                onChange({
                  version: 1,
                  environment: "development",
                  resourceId: resource.id,
                  resourceRevision: resource.revision,
                })
              }
            >
              Development database
              {selected ? <CheckIcon size={14} aria-hidden="true" /> : null}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>
              {query.isFetching
                ? "Checking database status…"
                : "No ready Development database"}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {value && !selected ? (
        <p role="status">
          The saved choice is not currently confirmed. Review Development or
          choose No database before sending.
        </p>
      ) : null}
    </div>
  );
}
