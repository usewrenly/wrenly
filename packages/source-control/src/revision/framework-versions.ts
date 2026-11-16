/** Imported version constraints stay unchanged; these are runtime families, not upgrade targets. */
const MAJORS = { nextjs: new Set([15,16]), laravel: new Set([12,13]) };
/** Accept ordinary exact/caret/tilde/wildcard and OR constraints confined to tested majors. */
export function supportsImportedVersion(framework: 'nextjs' | 'laravel', value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 120) return false;
  const ranges=value.split(/\s*\|\|?\s*/);
  return ranges.length <= 4 && ranges.every(range => {
    const match=/^[~^]?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(range.trim());
    return Boolean(match && MAJORS[framework].has(Number(match[1])) && (!/[xX*]/.test(match[2] ?? '') || match[3] === undefined));
  });
}
