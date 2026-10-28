//
// StatusPill — the one visual encoding of build status across dashboard,
// rail and workspace. Hairline pill + coloured dot (colour is never the
// only signal: the text label is always present too).

type BuildStatus = 'pending' | 'generating' | 'building' | 'retrying' | 'deploying' | 'success' | 'failed'

interface StatusPillProps {
  status: BuildStatus | 'idle'
  /** `pulse` animates the dot while a build is genuinely in flight. */
  animate?: boolean
}

const STATUS_META: Record<
  BuildStatus | 'idle',
  { label: string; dot: string; live?: boolean }
> = {
  idle: { label: 'no build', dot: 'bg-[var(--color-text-3)]' },
  pending: { label: 'queued', dot: 'bg-[var(--color-text-3)]', live: true },
  generating: { label: 'generating', dot: 'bg-[var(--color-success)]', live: true },
  building: { label: 'building', dot: 'bg-[var(--color-warning)]', live: true },
  retrying: { label: 'repairing', dot: 'bg-[var(--color-warning)]', live: true },
  deploying: { label: 'deploying', dot: 'bg-[var(--color-warning)]', live: true },
  success: { label: 'built', dot: 'bg-[var(--color-success)]' },
  failed: { label: 'failed', dot: 'bg-[var(--color-danger)]' },
}

export function StatusPill({ status, animate }: StatusPillProps) {
  const meta = STATUS_META[status]
  const live = meta.live && animate !== false

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-1)]">
      <span
        className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${
          live ? 'animate-pulse' : ''
        }`}
        aria-hidden
      />
      {meta.label}
    </span>
  )
}