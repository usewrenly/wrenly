"use client";
/** Viewer data belongs to one explicit selection and is discarded on selection change or failure. */
import { useEffect, useState } from "react";
import type { DatabaseViewerSelection, DatabaseViewerResult } from "@wrenly/db/app-database-viewer-contract";
import { requestDatabaseView } from "@/lib/databases/requests";
type ViewState = { key: string; status: "loading" | "unavailable"; result?: never }
  | { key: string; status: "loaded"; result: DatabaseViewerResult };

/** No query cache retains application rows after leaving the viewer. */
export function useDatabaseView(projectId: string, selection: DatabaseViewerSelection): ViewState {
  const key = JSON.stringify([projectId, selection]);
  const [state, setState] = useState<ViewState>({ key, status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    const input = JSON.parse(key) as [string, DatabaseViewerSelection];
    void requestDatabaseView(input[0], input[1], controller.signal).then((result) => {
      if (!controller.signal.aborted) setState({ key, status: "loaded", result });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ key, status: "unavailable" });
    });
    return () => controller.abort();
  }, [key]);
  return state.key === key ? state : { key, status: "loading" };
}
