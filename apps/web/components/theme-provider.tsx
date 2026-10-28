"use client";
// Theme preference applies across the full entry/app journey.
import { createContext, useContext, useEffect, useState } from "react";
type Theme = "system" | "light" | "dark";
const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
}>({ theme: "system", setTheme: () => {} });
function applyTheme(theme: Theme): void {
  if (theme === "system")
    document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}
/** Restores an explicit preference without requiring browser storage to be available. */
export function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>("system");
  useEffect(() => {
    try {
      const stored = localStorage.getItem("wrenly-theme");
      const value: Theme =
        stored === "light" || stored === "dark" ? stored : "system";
      setThemeState(value);
      applyTheme(value);
    } catch {
      applyTheme("system");
    }
  }, []);
  const setTheme = (value: Theme): void => {
    setThemeState(value);
    applyTheme(value);
    try {
      localStorage.setItem("wrenly-theme", value);
    } catch {
      /* A blocked preference store must not prevent theme changes. */
    }
  };
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  return useContext(ThemeContext);
}
