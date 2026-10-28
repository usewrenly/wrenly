// Explicit current framework profiles, not inferred roadmap availability.
import Link from "next/link";
export function FrameworkCards(): React.JSX.Element {
  return (
    <div className="docs-framework-grid not-prose">
      <Link className="docs-framework-card" href="/docs/guides/local-previews">
        <span className="docs-framework-logo docs-next-logo" aria-hidden="true">
          N<span>↗</span>
        </span>
        <div>
          <span className="docs-status" data-state="implemented">
            Implemented
          </span>
          <h3>Next.js</h3>
          <p>
            React applications with App Router, revision editing, isolated
            validation and previews.
          </p>
        </div>
      </Link>
      <Link className="docs-framework-card" href="/docs/guides/local-previews">
        <span
          className="docs-framework-logo docs-laravel-logo"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 40 40"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="m4 9 8-4 8 4v10l8 4 8-4V9l-8-4-8 4M4 9l8 5 8-5m-8 5v15l8 5 16-9V9m-16 10-8 5 8 5 16-9M4 9v16l8 4" />
          </svg>
        </span>
        <div>
          <span className="docs-status" data-state="implemented">
            Implemented
          </span>
          <h3>Laravel 13</h3>
          <p>
            PHP 8.4 applications with Composer, Artisan, local assets and
            FrankenPHP runtime support.
          </p>
        </div>
      </Link>
    </div>
  );
}
