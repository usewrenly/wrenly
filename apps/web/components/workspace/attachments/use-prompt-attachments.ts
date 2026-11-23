"use client";
/** Upload state is independent of prompt execution; uncertain responses retain the file and request identity. */
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  parsePromptAttachment,
  type PromptAttachment,
} from "@/lib/attachments/contracts";
export interface ComposerAttachment {
  localId: string;
  file: File;
  preview?: string;
  status: "uploading" | "ready" | "error";
  saved?: PromptAttachment;
  error?: string;
}
const UPLOAD_TIMEOUT_MS = 20_000;
export function usePromptAttachments(): {
  items: ComposerAttachment[];
  error: string | null;
  busy: boolean;
  blocked: boolean;
  ids: string[];
  add(files: FileList | File[]): void;
  remove(localId: string): void;
  retry(localId: string): void;
  clear(): void;
} {
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(items);
  current.current = items;
  const controllers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const publish = (next: ComposerAttachment[]): void => {
    current.current = next;
    if (mounted.current) setItems(next);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of controllers.current.values()) controller.abort();
      for (const item of current.current)
        if (item.preview) URL.revokeObjectURL(item.preview);
    };
  }, []);
  const upload = async (item: ComposerAttachment): Promise<void> => {
    const controller = new AbortController();
    controllers.current.set(item.localId, controller);
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    publish(
      current.current.map((row) =>
        row.localId === item.localId
          ? { ...row, status: "uploading", error: undefined }
          : row,
      ),
    );
    try {
      const response = await apiFetch(
        `/api/attachments?name=${encodeURIComponent(item.file.name)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "idempotency-key": item.localId,
          },
          body: item.file,
          signal: controller.signal,
        },
      );
      const body = (await response.json()) as {
        file?: unknown;
        error?: string;
      };
      if (!response.ok)
        throw new Error(body.error ?? "The file could not be uploaded.");
      const saved = parsePromptAttachment(body.file);
      if (mounted.current)
        publish(
          current.current.map((row) =>
            row.localId === item.localId
              ? { ...row, status: "ready", saved }
              : row,
          ),
        );
    } catch (failure) {
      if (
        !mounted.current ||
        !current.current.some((row) => row.localId === item.localId)
      )
        return;
      // A lost response is not proof that the upload failed; read its acknowledgement before offering retry.
      try {
        const status = await apiFetch(
          `/api/attachments/uploads/${item.localId}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (status.ok) {
          const body = (await status.json()) as { file?: unknown };
          if (body.file) {
            const saved = parsePromptAttachment(body.file);
            publish(
              current.current.map((row) =>
                row.localId === item.localId
                  ? { ...row, status: "ready", saved }
                  : row,
              ),
            );
            return;
          }
        }
      } catch {
        /* Keep the explicit uncertain state; Retry retains the same upload identity. */
      }
      publish(
        current.current.map((row) =>
          row.localId === item.localId
            ? {
                ...row,
                status: "error",
                error:
                  failure instanceof Error && failure.name !== "AbortError"
                    ? failure.message
                    : "Upload could not be confirmed. Retry or remove this file.",
              }
            : row,
        ),
      );
    } finally {
      clearTimeout(timer);
      controllers.current.delete(item.localId);
    }
  };
  return {
    items,
    error,
    busy: items.some((item) => item.status === "uploading"),
    blocked: items.some((item) => item.status !== "ready"),
    ids: items.flatMap((item) => (item.saved ? [item.saved.id] : [])),
    add(files) {
      setError(null);
      const additions = [...files];
      if (current.current.length + additions.length > 4) {
        setError("Attach up to four files per request.");
        return;
      }
      if (
        current.current.reduce((total, row) => total + row.file.size, 0) +
          additions.reduce((total, file) => total + file.size, 0) >
        12 * 1024 * 1024
      ) {
        setError("Reference files together must be at most 12 MiB.");
        return;
      }
      if (
        additions.some(
          (file) =>
            !/\.(png|jpe?g|webp|txt|md)$/i.test(file.name) ||
            file.name.length > 160 ||
            !file.size ||
            file.size >
              (/\.(txt|md)$/i.test(file.name) ? 64 * 1024 : 5 * 1024 * 1024),
        )
      ) {
        setError(
          "Choose images up to 5 MiB or TXT/Markdown documents up to 64 KiB.",
        );
        return;
      }
      const next: ComposerAttachment[] = additions.map((file) => ({
        localId: crypto.randomUUID(),
        file,
        status: "uploading",
        preview: /\.(png|jpe?g|webp)$/i.test(file.name)
          ? URL.createObjectURL(file)
          : undefined,
      }));
      publish([...current.current, ...next]);
      void (async () => {
        for (const item of next)
          if (
            mounted.current &&
            current.current.some((row) => row.localId === item.localId)
          )
            await upload(item);
      })();
    },
    remove(localId) {
      const item = current.current.find((row) => row.localId === localId);
      if (!item) return;
      controllers.current.get(localId)?.abort();
      if (item.preview) URL.revokeObjectURL(item.preview);
      publish(current.current.filter((row) => row.localId !== localId));
      if (item.saved)
        void apiFetch(`/api/attachments/${item.saved.id}`, {
          method: "DELETE",
        }).catch(() => {});
    },
    retry(localId) {
      const item = current.current.find((row) => row.localId === localId);
      if (item && !controllers.current.has(localId)) void upload(item);
    },
    clear() {
      for (const item of current.current)
        if (item.preview) URL.revokeObjectURL(item.preview);
      publish([]);
      setError(null);
    },
  };
}
