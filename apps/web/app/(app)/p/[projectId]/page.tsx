//
// Workspace route — /p/[projectId]. Server component hands the id to the
// client Workspace (which owns the SSE stream and build history).

import { Workspace } from '@/components/workspace/workspace'

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  return <Workspace projectId={projectId} />
}