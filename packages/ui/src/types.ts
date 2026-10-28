// packages/ui/src/types.ts
// Shared types for UI components.
// FileTree is duplicated here from @wrenly/nextjs-agent until
// Phase 2 consolidates these into @wrenly/types.

export type FileTree = Array<{
  path: string
  content: string
}>

export type Stack = 'nextjs' | 'laravel' | 'vue' | 'django'