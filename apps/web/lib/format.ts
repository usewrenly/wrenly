//
// Small formatting helpers shared by the shell, dashboard and workspace.

/**
 * Compact relative time for build rows: "just now", "4m ago", "2h ago",
 * "3d ago", then an absolute date. Server and client both call this —
 * no hydration-sensitive ticking (the dashboard refetch handles liveness).
 */
export function relativeTime(iso: string | Date): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''

  const diff = Date.now() - then
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`

  return new Date(then).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Turns a free-form prompt into a short project title: the first few
 * words, capped — projects need a human label before the agent names them.
 */
export function promptToTitle(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 6).join(' ')
  const capped = words.length > 60 ? `${words.slice(0, 57)}…` : words
  return capped || 'Untitled project'
}