import { z } from 'zod'
const deploymentSchema = z.object({
  id: z.string().min(1), buildId: z.string().min(1),
  status: z.enum(['queued', 'preparing', 'deploying', 'verifying', 'success', 'failed', 'interrupted', 'cancelled']),
  url: z.string().nullable(), errorCode: z.string().nullable(),
})
export type Deployment = z.infer<typeof deploymentSchema>
/** Checks operation identity and navigation fields before presenting selected-revision publishing. */
export function parseDeployment(value: unknown, buildId: string): Deployment | null {
  if (value === null) return null
  const parsed = deploymentSchema.safeParse(value)
  if (!parsed.success || parsed.data.buildId !== buildId) throw new Error('Invalid deployment status.')
  const deployment = parsed.data
  if (deployment.url !== null) {
    try {
      const url = new URL(deployment.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
      deployment.url = url.href
    } catch { throw new Error('Invalid deployment URL.') }
  }
  return deployment
}
