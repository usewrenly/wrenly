import { z } from 'zod'
const previewSchema = z.object({
  id: z.string().min(1), buildId: z.string().min(1),
  status: z.enum(['queued', 'preparing', 'starting', 'ready', 'failed', 'expired', 'stopped', 'interrupted']),
  log: z.string(), error: z.string().nullable(), cleanupPending: z.boolean(),
})
export type LocalPreview = z.infer<typeof previewSchema>
/** Missing cleanup metadata must not be interpreted as confirmed cleanup. */
export function parsePreview(value: unknown): LocalPreview | null {
  if (value === null) return null
  const parsed = previewSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid preview snapshot. Refresh before continuing.')
  return parsed.data
}
