// Shared entry-page presentation; routing/access checks belong to the entry gate.
import { DocumentationLink } from "@/components/documentation-link";
import { WrenlyMark } from "@/components/wrenly-mark";
import { ThemeToggle } from "@/components/theme-toggle";
interface EntryFrameProps {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}
/** Gives protected entry flows one visual frame without owning their auth or proof state. */
export function EntryFrame({
  eyebrow,
  title,
  description,
  children,
}: EntryFrameProps): React.JSX.Element {
  return (
    <div className="entry-page">
      <header className="entry-header">
        <a href="/" className="entry-brand" aria-label="Wrenly home">
          <WrenlyMark className="entry-mark" />
          <span>wrenly</span>
        </a>
        <div className="entry-header-actions">
          <span className="entry-instance">Self-hosted workspace</span>
          <ThemeToggle />
        </div>
      </header>
      <div className="entry-layout">
        <aside className="entry-story" aria-label="About Wrenly">
          <div className="entry-grid" aria-hidden="true" />
          <WrenlyMark
            className="entry-story-mark wrenly-wing-motion"
          />
          <div className="entry-story-content">
            <h2>
              From an idea.
              <br />
              To working
              <br />
              software.
            </h2>
            <p className="entry-story-description">
              Build your dream. Keep the code.
            </p>
            <div className="entry-principles">
              <span>Your instance</span>
              <span>Your models</span>
              <span>Your team</span>
              <span>Your code</span>
            </div>
          </div>
        </aside>
        <main className="entry-main">
          <div className="entry-content">
            <div className="entry-heading">
              <p className="entry-eyebrow">{eyebrow}</p>
              <h1>{title}</h1>
              <p>{description}</p>
            </div>
            {children}
            <footer className="entry-footer">
              <span>Authentication stays on this instance.</span>
              <DocumentationLink guide="guides/account-settings">Read more →</DocumentationLink>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}
