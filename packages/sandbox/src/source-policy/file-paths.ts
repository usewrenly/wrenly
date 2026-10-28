// COMPONENT: Generated file path validation
// PURPOSE: Reject ambiguous and escaping paths before creating any host file.
// INPUTS: Generated relative file paths.
// OUTPUTS: Validated portable paths, or an explicit validation error.
// STEPS: Reject absolute/dot segments; detect duplicates and ancestor collisions.
// EDGE CASES: Backslashes and drive prefixes are rejected on every host OS.
// ERROR STATES: Any invalid path rejects the entire tree before writes.
import * as path from 'path'

// Reject control characters intentionally; they must never reach a generated path.
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/

/** Validates the full tree before writing so invalid later entries cannot leave partial files. */
export function validateFilePaths(files: Array<{ path: string }>): void {
  const seen = new Set<string>()
  for (const file of files) {
    const name = file.path
    const segments = name.split('/')
    if (!name || name.includes('\\') || name.includes(':') || UNSAFE_CONTROL_CHARACTERS.test(name) ||
      path.isAbsolute(name) || segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
      throw new Error('Generated source contains an unsafe file path.')
    if (seen.has(name)) throw new Error('Generated source contains duplicate file paths.')
    seen.add(name)
  }
  for (const name of seen) {
    const segments = name.split('/')
    for (let index = 1; index < segments.length; index++) {
      if (seen.has(segments.slice(0, index).join('/')))
        throw new Error('Generated source contains a file/directory path collision.')
    }
  }
}
