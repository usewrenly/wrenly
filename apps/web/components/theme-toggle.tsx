// apps/web/components/theme-toggle.tsx
//
// Cycles through system → light → dark on each click.
// Reads and writes theme via ThemeProvider context.
// Used in the sidebar footer.

'use client'

import { SunIcon, MoonIcon, MonitorIcon } from 'lucide-react'
import { useTheme } from './theme-provider'

export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme()

  // Cycle: system → light → dark → system
  const next =
    theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'

  const Icon =
    theme === 'light' ? SunIcon : theme === 'dark' ? MoonIcon : MonitorIcon

  return (
    <button
      type="button"
      aria-label={`Theme: ${theme}. Switch to ${next} theme`}
      onClick={() => setTheme(next)}
      title={`Theme: ${theme}. Click to switch.`}
      className="rounded p-1 transition-colors hover:bg-[var(--color-surface-2)]"
    >
      <Icon size={14} className="text-[var(--color-text-3)]" />
    </button>
  )
}