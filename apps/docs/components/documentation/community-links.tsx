// Only operator-confirmed destinations render; no invented community URL.
export interface CommunityLinks {
  github?: string;
  discord?: string;
}
export function DocumentationCommunityLinks({
  links,
}: {
  links: CommunityLinks;
}): React.JSX.Element | null {
  if (!links.github && !links.discord) return null;
  return (
    <nav className="docs-community-links" aria-label="Wrenly community">
      {links.github ? (
        <a
          href={links.github}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Wrenly on GitHub"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.64-1.33-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03a9.6 9.6 0 0 1 5 0c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
          </svg>
        </a>
      ) : null}
      {links.discord ? (
        <a
          href={links.discord}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Wrenly on Discord"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M8 4 4 5C2 9 1 13 2 17l5 3 1-2m8-14 4 1c2 4 3 8 2 12l-5 3-1-2M7 7c3-1 7-1 10 0M6 16c4 2 8 2 12 0" />
            <ellipse cx="8" cy="12" rx="1" ry="1.5" />
            <ellipse cx="16" cy="12" rx="1" ry="1.5" />
          </svg>
        </a>
      ) : null}
    </nav>
  );
}
