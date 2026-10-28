// Groups saved file paths for browsing while preserving their original editor indexes.
export interface SourceFileNode {
  kind: "file";
  name: string;
  path: string;
  index: number;
}
export interface SourceFolderNode {
  kind: "folder";
  name: string;
  path: string;
  children: SourceNode[];
}
export type SourceNode = SourceFileNode | SourceFolderNode;

/** Keeps original source indexes while grouping paths; directories sort before files. */
export function buildSourceTree(
  files: ReadonlyArray<{ path: string }>,
  search = "",
): SourceNode[] {
  const root: SourceNode[] = [];
  const folders = new Map<string, SourceFolderNode>();
  const query = search.trim().toLocaleLowerCase();
  files.forEach((file, index) => {
    if (!file.path.toLocaleLowerCase().includes(query)) return;
    const parts = file.path.split("/");
    let siblings = root;
    parts.forEach((name, depth) => {
      const path = parts.slice(0, depth + 1).join("/");
      if (depth === parts.length - 1)
        siblings.push({ kind: "file", name, path: file.path, index });
      else {
        let folder = folders.get(path);
        if (!folder) {
          folder = { kind: "folder", name, path, children: [] };
          folders.set(path, folder);
          siblings.push(folder);
        }
        siblings = folder.children;
      }
    });
  });
  const sort = (nodes: SourceNode[]): void => {
    nodes.sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === "folder"
          ? -1
          : 1
        : a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
    );
    nodes.forEach((node) => {
      if (node.kind === "folder") sort(node.children);
    });
  };
  sort(root);
  return root;
}
