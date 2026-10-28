// The authenticated shell and owned API enforce access.
import { ProjectAccessSettings } from "@/components/workspace/settings/project-sharing";
export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<React.JSX.Element> {
  const { projectId } = await params;
  return <ProjectAccessSettings key={projectId} projectId={projectId} />;
}
