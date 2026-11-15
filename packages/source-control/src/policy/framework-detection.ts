/**
 * COMPONENT: Source framework detection
 * PURPOSE: Identify the application family from saved manifests without executing repository code.
 * INPUTS: Immutable text files at the selected application root.
 * OUTPUTS: Next.js or Laravel, or a fixed explanation when no single family is identifiable.
 * STEPS: Parse root manifests as data; inspect framework dependency keys; reject ambiguity.
 * EDGE CASES: Repositories containing both frameworks need an explicit family choice.
 * ERROR STATES: Malformed manifests and missing frameworks never fall back to a guessed starter.
 */
import type { SourceFile } from '../contracts/source';
export type SourceFramework = 'nextjs' | 'laravel';
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function manifest(files: readonly SourceFile[], path: string): Record<string, unknown> | undefined {
  const file = files.find(file => file.path === path);
  if (!file) return undefined;
  try {
    const parsed: unknown = JSON.parse(file.content);
    if (record(parsed)) return parsed;
  } catch { /* Only a fixed message leaves this parser; source content stays private. */ }
  throw new Error(`The repository has an invalid ${path}. Correct the manifest before importing.`);
}
/** Version and execution compatibility are checked separately after choosing a framework family. */
export function detectSourceFramework(files: readonly SourceFile[]): SourceFramework {
  const node = manifest(files, 'package.json');
  const composer = manifest(files, 'composer.json');
  const next = record(node?.dependencies) && typeof node.dependencies.next === 'string';
  const laravel = record(composer?.require) && typeof composer.require['laravel/framework'] === 'string';
  if (next && laravel) throw new Error('Both Next.js and Laravel manifests were found. Choose the framework for this application explicitly.');
  if (next) return 'nextjs';
  if (laravel) return 'laravel';
  throw new Error('No Next.js or Laravel application was found at the repository root. Check that you selected an application repository.');
}
