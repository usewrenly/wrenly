// Broken help links fail builds before publication.
import { readdir, readFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
const directory = resolve(import.meta.dir, "../content/docs");
async function filesIn(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? filesIn(join(folder, entry.name))
        : Promise.resolve(
            entry.name.endsWith(".mdx") ? [join(folder, entry.name)] : [],
          ),
    ),
  );
  return groups.flat();
}
async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
try {
  const files = await filesIn(directory);
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (content.includes("design-map/") || content.includes("design-maps/"))
      throw new Error(
        `${file}: public guides must not link to developer design notes.`,
      );
    const prose = content.replace(/```[\s\S]*?```/g, "");
    for (const match of prose.matchAll(/(?:\]\(([^)\s]+)\)|href=["\']([^"\']+)["\'])/g)) {
      const link = (match[1] ?? match[2])!.split("#")[0]!.split("?")[0]!;
      if (!link || /^[a-z]+:/i.test(link) || link.startsWith("//")) continue;
      const path =
        link === "/docs"
          ? directory
          : link.startsWith("/docs/")
            ? resolve(directory, link.slice(6))
            : link.startsWith("/")
              ? null
              : resolve(dirname(file), link);
      if (!path) continue;
      if (path !== directory && !path.startsWith(directory + "/"))
        throw new Error(`${file}: guide link escapes public content.`);
      if (
        !(await exists(path + ".mdx")) &&
        !(await exists(join(path, "index.mdx")))
      )
        throw new Error(`${file}: missing documentation target ${link}`);
    }
  }
  process.stdout.write(
    `Checked ${files.length} public guides: internal links and developer-reference boundary passed.\n`,
  );
} catch (error) {
  process.stderr.write(
    (error instanceof Error
      ? error.message
      : "Documentation verification failed") + "\n",
  );
  process.exitCode = 1;
}
