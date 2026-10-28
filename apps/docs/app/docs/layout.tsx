// Provider and navigation belong only to public docs.
import "../documentation.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocumentationHeader,
  HiddenNavigationTitle,
} from "../../components/documentation/header";
import { DocumentationCommunityLinks } from "../../components/documentation/community-links";
import { readDocumentationCommunityLinks } from "../../lib/community-links";
import { documentationTree } from "../../components/documentation/navigation";
export default async function DocumentationLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const { source } = await import("../../lib/source");
  return (
    <RootProvider
      search={{
        links: [
          ["Install Wrenly", "/docs/guides/installation"],
          ["Models & providers", "/docs/guides/model-provider-setup"],
          ["Publish a revision", "/docs/guides/private-publishing"],
        ],
        options: {
          footer: (
            <p key="docs-search-footer" className="docs-search-footer">
              Wrenly handbook · Search guides, concepts and reference
            </p>
          ),
        },
      }}
    >
      <div className="documentation">
        <DocsLayout
          tree={documentationTree(source.getPageTree())}
          tabs={false}
          themeSwitch={{ enabled: false }}
          nav={{
            url: "/docs",
            children: (
              <DocumentationCommunityLinks
                key="community-links"
                links={readDocumentationCommunityLinks()}
              />
            ),
          }}
          slots={{
            header: DocumentationHeader,
            navTitle: HiddenNavigationTitle,
          }}
          sidebar={{
            defaultOpenLevel: 1,
            collapsible: false,
            footer: (
              <p key="documentation-footer" className="docs-sidebar-note">
                The Wrenly handbook
                <br />
                Built to be understood.
              </p>
            ),
          }}
        >
          {children}
        </DocsLayout>
      </div>
    </RootProvider>
  );
}
