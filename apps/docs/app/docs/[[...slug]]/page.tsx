// Only generated collection slugs resolve to pages.
import { notFound } from "next/navigation";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import defaultComponents from "fumadocs-ui/mdx";
import {
  TaskCard,
  StatusBadge,
} from "../../../components/documentation/task-card";
import {
  ArchitectureDiagram,
  DatabaseDiagram,
} from "../../../components/documentation/architecture-diagram";
import { OverviewHero } from "../../../components/documentation/overview-hero";
import { ProductScreenshot } from "../../../components/documentation/product-screenshot";
import { FrameworkCards } from "../../../components/documentation/framework-cards";
import { ExecutionFlow } from "../../../components/documentation/execution-flow";
import type { Metadata } from "next";
export const dynamicParams = false;
type PageProps = { params: Promise<{ slug?: string[] }> };
export default async function Page({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { source } = await import("../../../lib/source");
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const Content = page.data.body;
  return (
    <DocsPage toc={page.data.toc}>
      {slug?.length ? (
        <>
          <DocsTitle className="docs-page-title">{page.data.title}</DocsTitle>
          <DocsDescription className="docs-page-description">
            {page.data.description}
          </DocsDescription>
        </>
      ) : null}
      <DocsBody>
        <Content
          components={{
            ...defaultComponents,
            TaskCard,
            StatusBadge,
            ArchitectureDiagram,
            DatabaseDiagram,
            OverviewHero,
            FrameworkCards,
            ExecutionFlow,
            ProductScreenshot,
          }}
        />
      </DocsBody>
    </DocsPage>
  );
}
export async function generateStaticParams(): Promise<{ slug: string[] }[]> {
  const { source } = await import("../../../lib/source");
  return source.generateParams();
}
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { source } = await import("../../../lib/source");
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return {
    title: `${page.data.title} · Wrenly docs`,
    description: page.data.description,
  };
}
