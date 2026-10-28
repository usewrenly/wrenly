"use client";
// Retain Fumadocs' search, theme and accessible drawer controllers.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDocsLayout } from "fumadocs-ui/layouts/docs";
import { ThemeSwitch } from "fumadocs-ui/layouts/shared/slots/theme-switch";
import { BrandMark } from "../brand-mark";
import { DocumentationIcon } from "./icons";
const links = [
  {
    label: "Guides",
    href: "/docs",
    matches: (path: string): boolean =>
      path === "/docs" ||
      path.startsWith("/docs/guides/") ||
      path.startsWith("/docs/why-wrenly"),
  },
  {
    label: "Architecture",
    href: "/docs/architecture/overview",
    matches: (path: string): boolean =>
      path.startsWith("/docs/architecture/") ||
      path.startsWith("/docs/reference/"),
  },
  {
    label: "Roadmap",
    href: "/docs/roadmap",
    matches: (path: string): boolean => path === "/docs/roadmap",
  },
];
export function DocumentationHeader(): React.JSX.Element {
  const pathname = usePathname();
  const {
    slots,
    props: { nav },
  } = useDocsLayout();
  const Trigger = slots.sidebar.trigger;
  const { open } = slots.sidebar.useSidebar();
  const Search = slots.searchTrigger ? slots.searchTrigger.sm : undefined;
  return (
    <header className="docs-header">
      <Trigger
        className="docs-mobile-menu docs-icon-button"
        aria-label={
          open
            ? "Close documentation navigation"
            : "Open documentation navigation"
        }
      >
        <DocumentationIcon name="menu" />
      </Trigger>
      <Link href="/docs" className="documentation-brand">
        <BrandMark />
        wrenly
      </Link>
      <span className="docs-brand-divider" aria-hidden="true">
        /
      </span>
      <span className="docs-header-label">Documentation</span>
      <nav className="docs-top-navigation" aria-label="Documentation sections">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={link.matches(pathname) ? "page" : undefined}
          >
            {link.label}
          </Link>
        ))}
      </nav>
      <div className="docs-header-actions">
        {nav?.children}
        <Link className="docs-product-link" href="https://usewrenly.org">
          Meet Wrenly ↗
        </Link>
        {Search ? (
          <Search
            className="docs-icon-button"
            aria-label="Search documentation"
          />
        ) : null}
        <ThemeSwitch mode="light-dark" />
      </div>
    </header>
  );
}
/** The brand belongs to the full-width header; sidebar retains its native search and tree. */
export function HiddenNavigationTitle(): null {
  return null;
}
