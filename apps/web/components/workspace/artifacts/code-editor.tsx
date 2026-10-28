"use client";
// Browses read-only saved source; selecting a file never creates or executes one.
import { useState } from "react";
import { FileCodeIcon, FolderIcon } from "lucide-react";
import { buildSourceTree, type SourceNode } from "@/lib/source-browser/source-tree";
interface FileItem {
  path: string;
  content: string;
}
interface CodeEditorProps {
  files: FileItem[];
  selectedFile: number;
  onSelectFile: (index: number) => void;
}
/** Browses real generated paths without pretending that the source viewer is an editor. */
export function CodeEditor({
  files,
  selectedFile,
  onSelectFile,
}: CodeEditorProps): React.JSX.Element {
  const [search, setSearch] = useState("");
  const nodes = buildSourceTree(files, search);
  const renderNodes = (items: SourceNode[]): React.ReactNode => (
    <ul>
      {items.map((node) => (
        <li key={`${node.kind}:${node.path}`}>
          {node.kind === "folder" ? (
            <details open key={`${node.path}:${Boolean(search.trim())}`}>
              <summary title={node.path}>
                <FolderIcon size={13} aria-hidden="true" />
                <span>{node.name}</span>
              </summary>
              {renderNodes(node.children)}
            </details>
          ) : (
            <button
              type="button"
              aria-pressed={node.index === selectedFile}
              title={node.path}
              onClick={() => onSelectFile(node.index)}
            >
              <FileCodeIcon size={13} aria-hidden="true" />
              <span>{node.name}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
  const selected = files[selectedFile];
  return (
    <div className="workspace-source-browser">
      <div className="workspace-file-list">
        <div className="workspace-file-heading">
          Files <span>{files.length}</span>
        </div>
        <input
          type="search"
          aria-label="Search generated files"
          placeholder="Find a file…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="workspace-file-paths">
          {renderNodes(nodes)}
          {!nodes.length && (
            <p>
              {files.length ? "No matching files." : "No generated files yet."}
            </p>
          )}
        </div>
      </div>
      <div className="workspace-source-content">
        <div className="workspace-source-path">
          {selected?.path ?? "Source"}
          <span>Read-only</span>
        </div>
        <pre
          tabIndex={0}
          aria-label={
            selected ? `Source for ${selected.path}` : "Generated source"
          }
        >
          {selected?.content ?? "Select a generated file to read its source."}
        </pre>
      </div>
    </div>
  );
}
