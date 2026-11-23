/** A selected application directory stays relative to its repository, never a host path. */
import { assertSourcePath, shouldExcludeSourcePath } from './import-policy';
/** Empty means repository root. Every persisted caller revalidates before joining remote paths. */
export function validateApplicationRoot(root: string): string {
  if (root === '') return root;
  assertSourcePath(root);
  if (shouldExcludeSourcePath(`${root}/package.json`)) throw new Error('Choose an application directory outside private configuration and installed dependencies.');
  return root;
}
/** Prefix an application-relative file when reviewing a GitHub write; sibling apps are untouched. */
export function repositorySourcePath(root: string, path: string): string {
  validateApplicationRoot(root);
  assertSourcePath(path);
  const result = root ? `${root}/${path}` : path;
  assertSourcePath(result);
  return result;
}
