"use client";
/**
 * COMPONENT: SavedAttachmentList
 * PURPOSE: Render inline sanitized image thumbnails with lightbox preview and safe document chips inside saved user messages.
 * INPUTS: PromptAttachment[] metadata attached to a persisted conversation turn.
 * OUTPUTS: Accessible thumbnail/document list with click-to-zoom preview dialog and new-tab links.
 * STEPS:
 *   1. Route image/webp items to lazy-loaded thumbnail buttons pointing to /api/attachments/:id.
 *   2. Track failed image loads and downgrade cleanly to bordered filename links without broken <img> icons.
 *   3. Render plain text / Markdown attachments as crisp bordered document links.
 *   4. Open a focused lightbox Dialog with image size metadata when a thumbnail is clicked.
 * EDGE CASES:
 *   - Empty attachment array -> returns null.
 *   - Revoked access / 403 / missing object -> onError flips item to filename fallback link cleanly.
 * ERROR STATES:
 *   - Failed image fetch never blocks the rest of the timeline or exposes internal storage IDs.
 */

import { useState } from "react";
import { ArrowUpRightIcon, FileTextIcon, ImageOffIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PromptAttachment } from "@/lib/attachments/contracts";

function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}`;
}

function formatByteLength(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Displays saved image thumbnails and document reference chips inside a prompt bubble. */
export function SavedAttachmentList({
  attachments,
}: {
  attachments?: PromptAttachment[];
}): React.JSX.Element | null {
  const [previewing, setPreviewing] = useState<PromptAttachment | null>(null);
  const [failedIds, setFailedIds] = useState<Record<string, true>>({});

  if (!attachments?.length) return null;

  return (
    <>
      <ul
        className="workspace-attachment-list"
        aria-label="Saved reference files"
      >
        {attachments.map((file) => {
          const href = attachmentUrl(file.id);
          const isImage =
            file.mediaType === "image/webp" && !failedIds[file.id];
          if (isImage) {
            return (
              <li key={file.id}>
                <button
                  type="button"
                  className="workspace-attachment-thumb"
                  aria-label={`Preview ${file.name}`}
                  onClick={() => setPreviewing(file)}
                >
                  <img
                    src={href}
                    alt={file.name}
                    loading="lazy"
                    decoding="async"
                    onError={() =>
                      setFailedIds((prev) => ({ ...prev, [file.id]: true }))
                    }
                  />
                  <span className="workspace-attachment-caption" title={file.name}>
                    {file.name}
                  </span>
                </button>
              </li>
            );
          }

          return (
            <li key={file.id}>
              <a
                className="workspace-attachment-file"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {file.mediaType === "image/webp" ? (
                  <ImageOffIcon size={13} aria-hidden="true" />
                ) : (
                  <FileTextIcon size={13} aria-hidden="true" />
                )}
                <span className="max-w-44 truncate">{file.name}</span>
                <ArrowUpRightIcon size={12} aria-hidden="true" />
              </a>
            </li>
          );
        })}
      </ul>

      <Dialog
        open={Boolean(previewing)}
        onOpenChange={(open) => {
          if (!open) setPreviewing(null);
        }}
      >
        {previewing && (
          <DialogContent className="workspace-attachment-lightbox gap-4">
            <DialogHeader className="min-w-0 pr-8">
              <DialogTitle className="truncate pr-0" title={previewing.name}>
                {previewing.name}
              </DialogTitle>
              <DialogDescription>
                {formatByteLength(previewing.byteLength)} · Sanitized private
                reference image
              </DialogDescription>
            </DialogHeader>
            <div className="flex max-h-[70vh] w-full min-w-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
              <img
                src={attachmentUrl(previewing.id)}
                alt={previewing.name}
                className="block max-h-[66vh] max-w-full rounded-lg object-contain"
              />
            </div>
            <DialogFooter>
              <a
                href={attachmentUrl(previewing.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-1)] hover:bg-[var(--color-surface-2)]"
              >
                Open in new tab
                <ArrowUpRightIcon size={13} aria-hidden="true" />
              </a>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
