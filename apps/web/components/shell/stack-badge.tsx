//
// StackBadge — tiny mono uppercase tag: NEXT / LARAVEL / VUE / DJANGO.
// Used in rails, rows and the workspace header.

import { stackLabel } from '@/lib/stacks'

export function StackBadge({ stack }: { stack: string }) {
  return (
    <span
      title={stackLabel(stack)}
      className="inline-flex shrink-0 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-2)]"
    >
      {stack}
    </span>
  )
}