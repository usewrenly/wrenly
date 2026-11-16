import { assertRevisionBudget } from "@wrenly/source-control/revision";
import { REVISION_LIMITS, isSourceAsset, type SourceAsset } from "@wrenly/source-control/revision"
// Validates explicit file changes against the complete saved revision before merging.
// Omission means keep the file: a partial model answer must never silently delete source.
import { z } from 'zod'
import { validateFilePaths } from '../../../../../packages/sandbox/src/source-policy/file-paths'
import type { FileTree } from './agent-client'

// Reject complete revisions beyond the model context budget rather than truncating them.
export const MAX_EDIT_CONTEXT_BYTES = 128_000
const MAX_FILES = 1000
const MAX_SOURCE_BYTES = REVISION_LIMITS.serializedBytes
const PathSchema = z.string().min(1).max(1024)
const FileSchema = z.object({ path: PathSchema, content: z.string(), asset: z.custom<SourceAsset>(isSourceAsset).optional() }).strict()
const EditResultSchema = z.object({ version: z.literal(1), operations: z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), path: PathSchema, content: z.string() }).strict(),
  z.object({ type: z.literal('update'), path: PathSchema, content: z.string() }).strict(),
  z.object({ type: z.literal('delete'), path: PathSchema }).strict(),
])).max(MAX_FILES) }).strict()

/** Rejects oversized complete source rather than silently presenting truncated code to a model. */
export function validateEditContext(files: FileTree): void {
  const parsed = z.array(FileSchema).min(1).max(MAX_FILES).parse(files)
  validateFilePaths(parsed)
  if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_EDIT_CONTEXT_BYTES)
    throw new Error('The complete revision exceeds the supported editing context budget. No source was truncated.')
}

/** Applies explicit changes atomically to a copy; omitted files and the input snapshot remain untouched. */
export function applyFileEdits(base: FileTree, value: unknown): FileTree {
  z.array(FileSchema).min(1).max(MAX_FILES).parse(base)
  validateFilePaths(base)
  const result = EditResultSchema.parse(value)
  const seen = new Set<string>()
  const files = new Map(base.map(file => [file.path, file]))
  for (const operation of result.operations) {
    validateFilePaths([{ path: operation.path }])
    if (seen.has(operation.path)) throw new Error('MCP edit response contains conflicting operations for one path.')
    seen.add(operation.path)
    const exists = files.has(operation.path)
    if (operation.type === 'create' && exists) throw new Error('MCP edit attempted to create an existing file.')
    if (operation.type !== 'create' && !exists) throw new Error('MCP edit referenced a file missing from the selected revision.')
    if (files.get(operation.path)?.asset) throw new Error('Model edits cannot replace or delete imported binary assets.')
    if (operation.type === 'delete') files.delete(operation.path)
    else files.set(operation.path, { path: operation.path, content: operation.content })
  }
  const merged = [...files.values()]
  if (!merged.length || merged.length > MAX_FILES || Buffer.byteLength(JSON.stringify(merged)) > MAX_SOURCE_BYTES)
    throw new Error('Edited source exceeds the build artifact limits or contains no files.')
  assertRevisionBudget(merged)
  validateFilePaths(merged)
  return merged
}

/** Select complete text files within model input bounds; the unselected revision is preserved locally. */
export function selectEditContext(files: FileTree, prompt: string): { files: FileTree; omitted: string[] } {
  z.array(FileSchema).min(1).max(MAX_FILES).parse(files);
  validateFilePaths(files);
  const named = prompt.toLowerCase();
  const priority = (path: string): number => named.includes(path.toLowerCase()) ? 0 : /^(?:package.json|composer.json|wrenly.app.json)$/.test(path) ? 1 : /(?:lock|\.md$|\.sql$)/i.test(path) ? 4 : /\.(?:tsx?|jsx?|vue|php|css)$/.test(path) ? 2 : 3;
  const ordered = files.filter(file => !file.asset).sort((a,b) => priority(a.path)-priority(b.path) || a.path.localeCompare(b.path));
  let bytes = 2;
  const selected: FileTree = [];
  for (const file of ordered) {
    const size = Buffer.byteLength(JSON.stringify(file)) + 1;
    if (bytes + size > MAX_EDIT_CONTEXT_BYTES) continue;
    selected.push({ path: file.path, content: file.content }); bytes += size;
  }
  if (!selected.length) throw new Error('No complete source file fits the model context. Split the requested file before editing.');
  const included = new Set(selected.map(file => file.path));
  return { files: selected, omitted: files.filter(file => !included.has(file.path)).map(file => file.path) };
}
