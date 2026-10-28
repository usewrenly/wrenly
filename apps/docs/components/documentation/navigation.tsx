// Group real compiled pages without changing their URLs.
import type { Root, Node, Item } from "fumadocs-core/page-tree";
import { DocumentationIcon, type DocumentationIconName } from "./icons";
const groups: { title: string; pages: [string, DocumentationIconName][] }[] = [
  {
    title: "Get started",
    pages: [
      ["/docs", "book"],
      ["/docs/why-wrenly", "layers"],
      ["/docs/guides/installation", "terminal"],
      ["/docs/guides/instance-setup", "shield"],
    ],
  },
  {
    title: "Workspace",
    pages: [
      ["/docs/guides/projects", "branch"],
      ["/docs/architecture/conversations", "sparkles"],
      ["/docs/guides/project-settings", "layers"],
    ],
  },
  {
    title: "Models & Skills",
    pages: [
      ["/docs/guides/model-provider-setup", "sparkles"],
      ["/docs/guides/skills", "book"],
    ],
  },
  {
    title: "Teams & access",
    pages: [
      ["/docs/guides/invitations", "users"],
      ["/docs/guides/account-settings", "shield"],
    ],
  },
  {
    title: "Run & publish",
    pages: [
      ["/docs/guides/local-previews", "layers"],
      ["/docs/guides/private-publishing", "rocket"],
      ["/docs/guides/publishing-setup", "terminal"],
      ["/docs/guides/app-databases", "database"],
      ["/docs/troubleshooting/build-failures", "info"],
    ],
  },
  {
    title: "Architecture",
    pages: [
      ["/docs/architecture/overview", "layers"],
      ["/docs/architecture/api", "terminal"],
      ["/docs/architecture/build-lifecycle", "branch"],
      ["/docs/architecture/project-structure", "book"],
    ],
  },
  {
    title: "Reference & direction",
    pages: [
      ["/docs/reference/http", "terminal"],
      ["/docs/reference/publishing-operations", "rocket"],
      ["/docs/roadmap", "branch"],
    ],
  },
];
/** Preserve generated page identities so Fumadocs breadcrumbs and neighbour links still work. */
export function documentationTree(tree: Root): Root {
  const pages = new Map<string, Item>();
  function collect(nodes: Node[]): void {
    for (const node of nodes) {
      if (node.type === "page") pages.set(node.url, node);
      if (node.type === "folder") {
        if (node.index) pages.set(node.index.url, node.index);
        collect(node.children);
      }
    }
  }
  collect(tree.children);
  const children: Node[] = [];
  for (const group of groups) {
    const groupPages: Item[] = [];
    for (const [url, icon] of group.pages) {
      const page = pages.get(url);
      if (!page)
        throw new Error(`Documentation navigation target missing: ${url}`);
      groupPages.push({ ...page, icon: <DocumentationIcon name={icon} /> });
      pages.delete(url);
    }
    children.push({
      type: "folder",
      $id: `docs-${group.title.toLowerCase().replace(/[^a-z]+/g, "-")}`,
      name: group.title,
      defaultOpen: group.title === "Get started",
      children: groupPages,
    });
  }
  if (pages.size)
    throw new Error(
      "Public documentation pages must belong to a navigation group.",
    );
  return { ...tree, children };
}
