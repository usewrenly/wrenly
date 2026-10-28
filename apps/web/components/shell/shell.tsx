"use client";
// Base UI owns modal focus, Escape, backdrop dismissal and trigger restoration.
import { useEffect, useRef, useState } from "react";
import { MenuIcon } from "lucide-react";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { TopBar } from "./top-bar";
import { ProjectRail } from "./project-rail";
const DESKTOP_QUERY = "(min-width: 1024px)";
/** Shares navigation/search across viewport modes without changing project or session authority. */
export function Shell({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const desktopSearch = useRef<HTMLInputElement>(null);
  const mobileSearch = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k" ||
        event.altKey
      )
        return;
      event.preventDefault();
      if (window.matchMedia(DESKTOP_QUERY).matches)
        desktopSearch.current?.focus();
      else {
        setOpen(true);
        mobileSearch.current?.focus();
      }
    };
    const media = window.matchMedia(DESKTOP_QUERY);
    const resize = (): void => {
      if (media.matches) setOpen(false);
    };
    window.addEventListener("keydown", shortcut);
    media.addEventListener("change", resize);
    return () => {
      window.removeEventListener("keydown", shortcut);
      media.removeEventListener("change", resize);
    };
  }, []);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <div className="app-shell">
        <a href="#main-content" className="app-skip-link">
          Skip to content
        </a>
        <aside className="app-desktop-rail">
          <ProjectRail search={search} />
        </aside>
        <div className="app-main-column">
          <TopBar
            search={search}
            onSearchChange={setSearch}
            searchRef={desktopSearch}
            onMobileSearch={() => setOpen(true)}
            mobileNavigation={
              <SheetTrigger
                className="app-icon-button app-mobile-control"
                aria-label="Open navigation"
              >
                <MenuIcon />
              </SheetTrigger>
            }
          />
          <main id="main-content" tabIndex={-1} className="app-main-content">
            {children}
          </main>
        </div>
      </div>
      <SheetContent
        side="left"
        className="app-navigation-drawer"
        initialFocus={mobileSearch}
      >
        <SheetTitle className="sr-only">Workspace navigation</SheetTitle>
        <ProjectRail
          search={search}
          onSearchChange={setSearch}
          searchInputRef={mobileSearch}
          onNavigate={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}
