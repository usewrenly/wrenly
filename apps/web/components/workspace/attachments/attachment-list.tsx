"use client";
import { FileTextIcon, Loader2Icon, XIcon } from "lucide-react";
import type { ComposerAttachment } from "./use-prompt-attachments";
/** Chips keep upload errors next to their file and never imply a failed reference was submitted. */
export function AttachmentList({
  items,
  disabled,
  remove,
  retry,
}: {
  items: ComposerAttachment[];
  disabled: boolean;
  remove(id: string): void;
  retry(id: string): void;
}): React.JSX.Element | null {
  if (!items.length) return null;
  return (
    <ul
      className="flex flex-wrap gap-2 px-4 pt-3"
      aria-label="Prompt attachments"
    >
      {items.map((item) => (
        <li
          key={item.localId}
          className="flex max-w-full items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-xs"
        >
          {item.preview ? (
            <img
              src={item.preview}
              alt=""
              className="h-10 w-12 rounded-md object-contain"
            />
          ) : (
            <FileTextIcon size={20} aria-hidden="true" />
          )}
          <span className="min-w-0">
            <span className="block max-w-48 truncate font-medium">
              {item.file.name}
            </span>
            <span
              role="status"
              className="block max-w-64 text-[var(--color-text-3)]"
            >
              {item.status === "uploading"
                ? "Uploading…"
                : item.status === "ready"
                  ? "Ready"
                  : item.error}
            </span>
          </span>
          {item.status === "uploading" && (
            <Loader2Icon
              size={14}
              className="animate-spin"
              aria-hidden="true"
            />
          )}
          {item.status === "error" && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => retry(item.localId)}
              className="underline"
            >
              Retry
            </button>
          )}
          <button
            type="button"
            aria-label={`Remove ${item.file.name}`}
            disabled={disabled}
            onClick={() => remove(item.localId)}
            className="rounded-md p-1 hover:bg-[var(--color-surface)]"
          >
            <XIcon size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}
