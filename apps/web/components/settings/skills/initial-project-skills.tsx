"use client";
// Select saved personal versions before project creation; merely opening this dialog runs no model.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon, CheckIcon } from "lucide-react";
import { LibrarySchema } from "@/lib/skills/contracts";
import { skillRequest } from "@/lib/skills/client";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
const MAX_INITIAL_SKILLS = 4;
export function InitialProjectSkills({
  versionIds,
  onChange,
  disabled,
}: {
  versionIds: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["skills-library"],
    enabled: open,
    retry: false,
    queryFn: ({ signal }) =>
      skillRequest("/api/skills", LibrarySchema, { signal }),
  });
  const available =
    query.data?.skills.filter((item) => !item.skill.archivedAt) ?? [];
  return (
    <>
      <button
        type="button"
        className="composer-menu-action"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <BookOpenIcon size={16} aria-hidden="true" />
        <span>
          <strong>Skills</strong>
          <small>
            {versionIds.length
              ? `${versionIds.length} selected for your first prompt`
              : "Give your first prompt reusable guidance"}
          </small>
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Start with your Skills</DialogTitle>
          <DialogDescription>
            Choose up to four saved instructions. They will be pinned to the new
            project before your first prompt is sent.
          </DialogDescription>
          <div className="max-h-80 space-y-2 overflow-y-auto py-4">
            {query.isPending && <p role="status">Loading your Skills…</p>}
            {query.isError && (
              <p role="alert">
                Your Skills could not be loaded.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => void query.refetch()}
                >
                  Try again
                </button>
              </p>
            )}
            {!query.isPending && !query.isError && !available.length && (
              <p>
                No saved Skills yet.{" "}
                <a href="/settings/skills" className="underline">
                  Create or import one in Settings →
                </a>
              </p>
            )}
            {available.map(({ skill, version }) => {
              const checked = versionIds.includes(version.id);
              return (
                <div
                  className="rounded-lg border border-[var(--color-border)] p-3"
                  key={skill.id}
                >
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={
                        disabled ||
                        (!checked && versionIds.length >= MAX_INITIAL_SKILLS)
                      }
                      onChange={() =>
                        onChange(
                          checked
                            ? versionIds.filter((id) => id !== version.id)
                            : [...versionIds, version.id],
                        )
                      }
                    />
                    <span>
                      <strong className="text-sm">{version.name}</strong>
                      <span className="mt-1 block text-xs text-[var(--color-text-2)]">
                        {version.description}
                      </span>
                    </span>
                    {checked && <CheckIcon size={14} aria-hidden="true" />}
                  </label>
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer">
                      Review saved instructions
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words">
                      {version.document}
                    </pre>
                  </details>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <span className="mr-auto text-xs">
              {versionIds.length} / {MAX_INITIAL_SKILLS} selected
            </span>
            {versionIds.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onChange([])}
                disabled={disabled}
              >
                Clear selection
              </Button>
            )}
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
