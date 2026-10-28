"use client";
/** Connects authenticated status to the overview/viewer without admitting resource operations on mount. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { requestDatabaseStatus } from "@/lib/databases/requests";
import { DatabaseOverview } from "./database-overview";
import { DatabaseViewer } from "./database-viewer";
import { DatabaseOwnerControls } from "./database-owner-controls";

const ACTIVE_STATUS_POLL_MS = 1500;
const IDLE_STATUS_POLL_MS = 10000;

/** Mutations require an explicit authenticated actor plus current server management capability. */
export function DatabaseWorkspace({
  projectId,
  actorId,
  selectedBuildId,
  selectedBuildSuccessful = false,
}: {
  projectId: string;
  actorId: string;
  selectedBuildId?: string;
  selectedBuildSuccessful?: boolean;
}): React.JSX.Element {
  const query = useQuery({
    queryKey: ["project-databases", actorId, projectId],
    queryFn: ({ signal }) => requestDatabaseStatus(projectId, signal),
    retry: false,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.operations.some(
        (operation) =>
          operation.status === "queued" || operation.status === "running",
      ) ||
      query.state.data?.resources.some(
        (resource) => resource.status === "provisioning",
      )
        ? ACTIVE_STATUS_POLL_MS
        : IDLE_STATUS_POLL_MS,
    refetchIntervalInBackground: false,
  });
  const [selection, setSelection] = useState<{
    projectId: string;
    actorId: string;
    resourceId: string;
    revision: string;
    view: "rows" | "schema";
  } | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<"start" | "stop" | null>(null);
  const [management, setManagement] = useState<{
    projectId: string;
    actorId: string;
    environment: "development" | "production";
  } | null>(null);
  const environment =
    management?.projectId === projectId && management.actorId === actorId
      ? management.environment
      : null;
  const setEnvironment = (value: "development" | "production" | null): void => {
    setManagement((current) =>
      value === null
        ? current?.projectId === projectId && current.actorId === actorId
          ? null
          : current
        : { projectId, actorId, environment: value },
    );
  };
  const [notice, setNotice] = useState<{
    projectId: string;
    actorId: string;
    text: string;
  } | null>(null);
  const reload = (): void => {
    setSelection((current) =>
      current?.projectId === projectId && current.actorId === actorId
        ? null
        : current,
    );
    void query.refetch();
  };
  if (query.isPending)
    return (
      <DatabaseOverview
        projectId={projectId}
        state={{ status: "loading" }}
        onReload={reload}
      />
    );
  if (!query.data)
    return (
      <DatabaseOverview
        projectId={projectId}
        state={{ status: "unavailable" }}
        onReload={reload}
      />
    );
  const status = query.data;
  const resource =
    selection?.projectId === projectId && selection.actorId === actorId
      ? status.resources.find(
          (item) =>
            item.id === selection.resourceId &&
            item.revision === selection.revision &&
            item.status === "ready",
        )
      : undefined;
  if (
    !query.isError &&
    selection &&
    resource &&
    selection.projectId === projectId &&
    selection.actorId === actorId
  )
    return (
      <DatabaseViewer
        key={JSON.stringify([
          projectId,
          actorId,
          resource.id,
          resource.revision,
          status.capabilities,
        ])}
        projectId={projectId}
        resource={resource}
        capabilities={status.capabilities}
        initialView={selection.view}
        onClose={reload}
      />
    );
  return (
    <>
      {notice?.projectId === projectId && notice.actorId === actorId ? (
        <p role="status" className="database-attention">
          {notice.text}
        </p>
      ) : null}
      {query.isError && (
        <p role="alert" className="database-attention">
          Status could not be refreshed. Check again before submitting another
          action.
        </p>
      )}
      <DatabaseOverview
        projectId={projectId}
        state={
          query.isError
            ? { status: "unavailable" }
            : { status: "loaded", projectId, value: status }
        }
        onReload={reload}
        onCreate={
          actorId && status.capabilities.manage
            ? (value) => setEnvironment(value)
            : undefined
        }
        onLifecycle={actorId && status.capabilities.manage ? (id, action) => {
          const resource = status.resources.find(item => item.id === id);
          if (resource) { setLifecycleAction(action); setEnvironment(resource.environment); }
        } : undefined}
        onManage={
          actorId && status.capabilities.manage
            ? (id) => {
                const resource = status.resources.find(
                  (item) => item.id === id,
                );
                if (resource) { setLifecycleAction(null); setEnvironment(resource.environment); }
              }
            : undefined
        }
        onOpen={(id, view) => {
          const current = status.resources.find(
            (item) => item.id === id && item.status === "ready",
          );
          if (current)
            setSelection({
              projectId,
              actorId,
              resourceId: id,
              revision: current.revision,
              view,
            });
        }}
      />
      {actorId && status.capabilities.manage ? (
        <DatabaseOwnerControls
          key={`${projectId}:${actorId}:${selectedBuildId ?? "none"}:${lifecycleAction ?? "manage"}`}
          initialAction={lifecycleAction}
          projectId={projectId}
          actorId={actorId}
          selectedBuildId={selectedBuildId}
          selectedBuildSuccessful={selectedBuildSuccessful}
          status={status}
          unavailable={query.isError}
          environment={environment}
          onClose={() => { setLifecycleAction(null); setEnvironment(null); }}
          onReload={reload}
          onAccepted={() => {
            setLifecycleAction(null);
            setNotice({
              projectId,
              actorId,
              text: "Database request accepted. Follow its execution in recent activity.",
            });
            setEnvironment(null);
            reload();
          }}
        />
      ) : null}
    </>
  );
}
