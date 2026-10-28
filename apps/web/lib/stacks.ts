// Framework display names include planned stacks so existing project facts stay readable.
// Composer availability is explicit: Next.js and Laravel are enabled; Vue/Django are planned.

export type StackId = 'nextjs' | 'laravel' | 'vue' | 'django'

export interface StackOption {
  id: StackId
  label: string
  /** Short mono badge text — kept distinct from the label (e.g. Next.js / NEXT). */
  badge: string
}

export const STACKS: StackOption[] = [
  { id: 'nextjs', label: 'Next.js', badge: 'next' },
  { id: 'laravel', label: 'Laravel', badge: 'laravel' },
  { id: 'vue', label: 'Vue.js', badge: 'vue' },
  { id: 'django', label: 'Django', badge: 'django' },
]

export function stackLabel(id: string): string {
  return STACKS.find(s => s.id === id)?.label ?? id
}
