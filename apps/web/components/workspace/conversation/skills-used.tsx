"use client";
// Read-only history of exact admitted versions, never current defaults.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { type SkillUsed } from "@/lib/skills/contracts";
import { skillRequest } from "@/lib/skills/client";
import "../../settings/skills/skills.css";
const Usage = z.object({
  skillsUsed: z
    .array(
      z.object({
        name: z.string(),
        versionId: z.string().uuid(),
        sha256: z.string(),
      }),
    )
    .max(4),
});
export function SkillsUsed({
  items,
  buildId,
}: {
  items?: SkillUsed[];
  buildId?: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["build-skills-used", buildId],
    queryFn: ({ signal }) =>
      skillRequest(`/api/builds/${buildId}`, Usage, { signal }),
    enabled: Boolean(open && buildId && items === undefined),
    retry: false,
  });
  if ((!buildId && items === undefined) || items?.length === 0) return null;
  const used = items ?? query.data?.skillsUsed;
  return (
    <details
      className="skills-used"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Skills used{items ? ` · ${items.length}` : ""}</summary>
      {query.isError ? (
        <p role="alert">
          This revision's skill history could not be loaded.{" "}
          <button onClick={() => void query.refetch()}>Try again</button>
        </p>
      ) : used ? (
        used.length ? (
          <ul>
            {used.map((item) => (
              <li key={item.versionId}>
                <strong>{item.name}</strong>
                <br />
                Version <code>{item.versionId}</code>
                <br />
                SHA-256 <code>{item.sha256}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>No project skills were recorded for this build.</p>
        )
      ) : (
        <p role="status">Loading recorded versions…</p>
      )}
    </details>
  );
}
