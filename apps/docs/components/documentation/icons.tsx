// Local vectors keep offline docs independent of icon CDNs.
import type { ReactNode } from "react";
const paths = {
  book: (
    <>
      <path d="M12 5v16M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2z" />
    </>
  ),
  terminal: <path d="m5 7 5 5-5 5m8 0h6" />,
  layers: <path d="m12 3 10 6-10 6L2 9zm-10 10 10 6 10-6M2 17l10 6 10-6" />,
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3m3-18a4 4 0 0 1 0 8m0 4a5 5 0 0 1 4 5" />
    </>
  ),
  sparkles: <path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3zM20 2v4m-2-2h4" />,
  rocket: (
    <>
      <path d="M8 16c0-7 5-12 13-13 0 8-6 14-13 14L4 21l-1-1 4-5M8 10H3l-1 5h5m7 1v5l5-1v-5" />
      <circle cx="16" cy="8" r="2" />
    </>
  ),
  shield: <path d="m12 2 9 4v6c0 5-5 9-9 10-4-1-9-5-9-10V6zm-5 9 3 3 7-7" />,
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="5" r="2" />
      <path d="M6 7v10m0-4c8 0 12-2 12-6" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 11v6m0-10v1" />
    </>
  ),
} satisfies Record<string, ReactNode>;
export type DocumentationIconName = keyof typeof paths;
export function DocumentationIcon({
  name,
}: {
  name: DocumentationIconName;
}): React.JSX.Element {
  if (!paths[name]) throw new Error("Unknown documentation icon.");
  return (
    <svg
      className="docs-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
