"use client";
// Reuses the existing browser theme preference.
import { MonitorIcon, SunIcon, MoonIcon, CheckIcon } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
const THEMES = [
  {
    value: "system",
    label: "System",
    description: "Follow this device’s appearance.",
    icon: MonitorIcon,
  },
  {
    value: "light",
    label: "Light",
    description: "Warm paper and quiet ink.",
    icon: SunIcon,
  },
  {
    value: "dark",
    label: "Dark",
    description: "A softer workspace after hours.",
    icon: MoonIcon,
  },
] as const;
export default function AppearanceSettingsPage(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <header className="settings-page-heading">
        <p>Make room for focus</p>
        <h1>Appearance</h1>
        <span>Choose how Wrenly looks in this browser.</span>
      </header>
      <section className="settings-section">
        <h2>Theme</h2>
        <p>Applies immediately. Other members’ preferences stay their own.</p>
        <div
          className="settings-theme-options"
          role="group"
          aria-label="Color theme"
        >
          {THEMES.map(({ value, label, description, icon: Icon }) => (
            <button
              type="button"
              key={value}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
            >
              <Icon size={22} aria-hidden="true" />
              <strong>{label}</strong>
              <span>{description}</span>
              {theme === value && <CheckIcon size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
