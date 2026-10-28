"use client";
// Revision changes/unmount abort the download; exporting never starts build work.
import { useEffect, useRef, useState } from "react";
import { DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { loadSourceDownload } from "@/lib/source-download/client";
const DOWNLOAD_DEADLINE_MS = 20_000;
const OBJECT_URL_TTL_MS = 30_000;
export function SourceDownload({
  buildId,
  available,
}: {
  buildId?: string;
  available: boolean;
}): React.JSX.Element {
  const operation = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setLoading(false);
    setMessage(null);
    return () => {
      operation.current?.abort();
      operation.current = null;
    };
  }, [buildId]);
  async function download(): Promise<void> {
    if (!buildId || !available || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setLoading(true);
    setMessage(null);
    const timer = setTimeout(
      () =>
        controller.abort(new Error("Source download timed out. Try again.")),
      DOWNLOAD_DEADLINE_MS,
    );
    try {
      const bytes = await loadSourceDownload(
        buildId,
        apiFetch,
        controller.signal,
      );
      if (operation.current !== controller || controller.signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/zip" }),
      );
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `wrenly-${buildId}.zip`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setMessage("Download started.");
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_TTL_MS);
      }
    } catch (error) {
      if (operation.current === controller)
        setMessage(
          error instanceof Error
            ? error.message
            : "Download could not be started. Try again.",
        );
    } finally {
      clearTimeout(timer);
      if (operation.current === controller) {
        operation.current = null;
        setLoading(false);
      }
    }
  }
  return (
    <div className="workspace-source-download">
      <button
        type="button"
        className="workspace-source-download-button"
        onClick={() => {
          void download();
        }}
        disabled={!available || loading}
        aria-busy={loading}
        title={
          available
            ? "Download this saved revision as a ZIP"
            : "Select a finished revision with saved source"
        }
      >
        {loading ? (
          <LoaderCircleIcon
            size={14}
            className="animate-spin"
            aria-hidden="true"
          />
        ) : (
          <DownloadIcon size={14} aria-hidden="true" />
        )}
        <span>{loading ? "Preparing…" : "Download source"}</span>
      </button>
      {message ? (
        <span className="workspace-download-notice" role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}
