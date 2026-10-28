import { z } from 'zod'
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)))
// Sidebar links use this field directly; reject executable schemes and embedded credentials.
const deployedUrl = z.string().refine(value => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && value === value.trim() && !/\s/.test(value)
  } catch { return false }
}).nullable()
const projectSchema = z.object({
  id: z.string().min(1), name: z.string(), stack: z.string(),
  owned: z.boolean().optional(), archivedAt: timestamp.nullable().optional(),
  accessMode: z.enum(['private', 'selected', 'instance']).optional(),
  description: z.string().nullable().optional(), createdAt: timestamp, updatedAt: timestamp,
  latestBuild: z.object({
    id: z.string().min(1), status: z.enum(['pending', 'generating', 'building', 'success', 'failed']),
    attemptCount: z.number().int().nonnegative(), deployedUrl, createdAt: timestamp,
  }).nullable(),
})
export type Project = z.infer<typeof projectSchema>
const listSchema = z.object({ projects: z.array(projectSchema) })
/** Only validated public summaries enter navigation; malformed responses are never empty collections. */
export function parseProjectList(value: unknown): Project[] {
  const parsed = listSchema.safeParse(value)
  if (!parsed.success) throw new Error('Project summaries could not be read. Refresh before continuing.')
  return parsed.data.projects
}
