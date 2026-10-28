import { DraftEditor } from "@/components/drafts/draft-editor";
export default async function DraftPage({
  params,
}: {
  params: Promise<{ draftId: string }>;
}): Promise<React.JSX.Element> {
  const { draftId } = await params;
  return <DraftEditor key={draftId} id={draftId} />;
}
