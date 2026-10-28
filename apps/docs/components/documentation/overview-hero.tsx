// Welcome readers with Wrenly's warm handbook composition.
import Link from "next/link";
import { BrandMark } from "../brand-mark";
import { DocumentationIcon } from "./icons";
export function OverviewHero(): React.JSX.Element {
  return (
    <section
      className="docs-welcome not-prose"
      aria-label="Welcome to the Wrenly handbook"
    >
      <div className="docs-welcome-brand">
        <BrandMark />
        <span>The Wrenly handbook</span>
      </div>
      <h1>Good ideas start here.</h1>
      <p>
        Get comfortable in your workspace. Connect your models, shape an idea
        with your team and build something you can call your own.
      </p>
      <div className="docs-hero-actions">
        <Link
          className="docs-button docs-button-primary"
          href="/docs/guides/installation"
        >
          Set up your workspace <DocumentationIcon name="arrow" />
        </Link>
        <Link className="docs-button" href="/docs/guides/projects">
          Find your way around
        </Link>
      </div>
      <nav className="docs-welcome-journey" aria-label="Your first steps">
        <Link href="/docs/guides/model-provider-setup">
          <span>01</span>Connect your model
        </Link>
        <Link href="/docs/architecture/conversations">
          <span>02</span>Shape your idea
        </Link>
        <Link href="/docs/guides/local-previews">
          <span>03</span>See it come to life
        </Link>
      </nav>
    </section>
  );
}
