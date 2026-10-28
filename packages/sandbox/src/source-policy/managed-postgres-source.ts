/** Checks known incompatible Postgres.js connection patterns without executing app code.
 * This is repair guidance, not a network security boundary: Docker still blocks IP egress.
 */
const SOURCE_PATH = /\.[cm]?[jt]sx?$/;
const STRINGS_OR_COMMENTS = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
const POSTGRES_IMPORT = /\bfrom\s*["']postgres["']|\brequire\s*\(\s*["']postgres["']\s*\)/;
const URL_VARIABLE = /\bprocess\s*\.\s*env\s*(?:\.\s*(?:DATABASE_URL|POSTGRES_URL)\b|\[\s*["'](?:DATABASE_URL|POSTGRES_URL)["']\s*\])/;
const CONNECTION_URI = /["'`]postgres(?:ql)?:\/\//;

/** Return only fixed safe guidance for a supported driver's known wrong connection form. */
export function managedPostgresConnectionProblem(files: Array<{ path: string; content: string }>): string | null {
  for (const file of files) {
    if (!SOURCE_PATH.test(file.path)) continue;
    // Preserve string literals (including URLs) so comment markers inside them are data.
    const source = file.content.replace(STRINGS_OR_COMMENTS, token => token.startsWith("//") || token.startsWith("/*") ? " " : token);
    if (!POSTGRES_IMPORT.test(source)) continue;
    if (URL_VARIABLE.test(source) || CONNECTION_URI.test(source)) {
      return "Managed PostgreSQL supplies PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD, not DATABASE_URL. In the Postgres.js connection module use postgres() with no URL, or explicit PG* options. Remove localhost/TCP/credential fallback URLs. Never invent a connection string.";
    }
  }
  return null;
}

const PAGE_PATH = /^(?:src\/)?app\/(?:.*\/)?page\.[jt]sx?$/;
const CLIENT_PAGE = /^\s*["']use client["']\s*(?:;|\r?\n)/;
const DYNAMIC_RENDERING = /\bexport\s+const\s+dynamic\s*=\s*["']force-dynamic["']|\bexport\s+const\s+revalidate\s*=\s*0\b/;
/** Offline compilation has no database credentials or socket; managed server pages must render at runtime. */
export function managedDatabaseRenderingProblem(files: Array<{ path: string; content: string }>): string | null {
  for (const page of files) {
    if (!PAGE_PATH.test(page.path)) continue;
    const source = page.content.replace(STRINGS_OR_COMMENTS, token => token.startsWith("//") || token.startsWith("/*") ? " " : token);
    if (CLIENT_PAGE.test(source) || DYNAMIC_RENDERING.test(source)) continue;
    const root = page.path.startsWith("src/") ? "src/app" : "app";
    const layout = files.find(file => new RegExp(`^${root}/layout\\.[jt]sx?$`).test(file.path));
    const layoutSource = layout?.content.replace(STRINGS_OR_COMMENTS, token => token.startsWith("//") || token.startsWith("/*") ? " " : token) ?? "";
    if (DYNAMIC_RENDERING.test(layoutSource)) continue;
    return "Managed database server pages must render at runtime. Add export const dynamic = 'force-dynamic' to each server page or its root layout (or export const revalidate = 0). next build runs offline without database access; do not query the database during static page generation.";
  }
  return null;
}
