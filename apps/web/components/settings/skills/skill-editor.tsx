"use client";
// Editing/importing text has no model or execution effect.
import { useRef } from "react";
import { FileTextIcon, UploadIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { SkillProvenance } from "@/lib/skills/contracts";
export const EMPTY_SKILL: SkillProvenance = {
  document:
    "---\nname: clear-interface-copy\ndescription: Write clear, concise interface labels and helpful error messages.\n---\nUse concrete verbs. Explain what the user can do next.\n",
  source: "authored",
  sourceUrl: null,
  versionLabel: null,
  licenseNotes: "",
};
export function SkillEditor({
  value,
  onChange,
  disabled,
  onError,
}: {
  value: SkillProvenance;
  onChange: (value: SkillProvenance) => void;
  disabled: boolean;
  onError: (message: string) => void;
}): React.JSX.Element {
  const file = useRef<HTMLInputElement>(null);
  const bytes = new TextEncoder().encode(value.document).length;
  return (
    <div className="skill-editor">
      <div className="skill-editor-toolbar">
        <span>
          <FileTextIcon size={15} aria-hidden="true" /> SKILL.md
        </span>
        <div>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange({ ...value, source: "imported" })}
          >
            Import text
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => file.current?.click()}
          >
            <UploadIcon size={14} aria-hidden="true" />
            Import file
          </Button>
        </div>
      </div>
      <input
        ref={file}
        aria-label="Import SKILL.md"
        type="file"
        accept=".md,text/markdown,text/plain"
        hidden
        disabled={disabled}
        onChange={async (event) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          if (!selected) return;
          try {
            if (selected.name !== "SKILL.md" || selected.size > 16 * 1024)
              throw new Error("Choose one SKILL.md file of at most 16 KiB.");
            const document = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(await selected.arrayBuffer());
            onChange({ ...value, document, source: "imported" });
          } catch (error) {
            onError(
              error instanceof Error
                ? error.message
                : "This file could not be read.",
            );
          }
        }}
      />
      <label className="sr-only" htmlFor="skill-document">
        Skill document
      </label>
      <textarea
        id="skill-document"
        value={value.document}
        readOnly={disabled}
        aria-disabled={disabled}
        spellCheck={false}
        onChange={(event) =>
          onChange({ ...value, document: event.target.value })
        }
      />
      <p
        className="skill-editor-budget"
        role={bytes > 16 * 1024 ? "alert" : undefined}
      >
        {bytes.toLocaleString()} / 16,384 bytes · instructions only
      </p>
      <div className="skill-provenance-fields">
        <label>
          Source URL <span>Optional; recorded without fetching</span>
          <Input
            value={value.sourceUrl ?? ""}
            disabled={disabled}
            placeholder="https://example.com/skills/clear-copy"
            maxLength={2048}
            onChange={(event) =>
              onChange({ ...value, sourceUrl: event.target.value || null })
            }
          />
        </label>
        <label>
          Version label <span>Optional</span>
          <Input
            value={value.versionLabel ?? ""}
            disabled={disabled}
            maxLength={64}
            placeholder="1.0"
            onChange={(event) =>
              onChange({ ...value, versionLabel: event.target.value || null })
            }
          />
        </label>
        <label className="skill-license-field">
          Attribution and license notes{" "}
          <span>Preserve the author's terms when importing</span>
          <Input
            value={value.licenseNotes}
            disabled={disabled}
            maxLength={2000}
            onChange={(event) =>
              onChange({ ...value, licenseNotes: event.target.value })
            }
          />
        </label>
      </div>
    </div>
  );
}
