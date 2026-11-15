/** Inspects selected source as data; never installs packages or executes repository configuration. */
import { z } from "zod";
import {
  detectSourceFramework,
  validateApplicationRoot,
  readGitHubRepository,
  readGitHubSnapshot,
  type GitHubReadClient,
  type GitHubSourceSnapshot,
} from "@wrenly/source-control";
import { SourceConnectionError } from "../github/authorization-store";
import { validateLaravelSource } from "../../../../../../packages/sandbox/src/source-policy/laravel-runtime";
import { validateNextjsStyling } from "../../../../../../packages/sandbox/src/source-policy/nextjs-styling";
const Selection = z
  .object({
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    ref: z.string().max(120),
    applicationRoot: z.string().max(400).default(""),
    stack: z.enum(["auto", "nextjs", "laravel"]).default("auto"),
  })
  .strict();
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Resolve a branch once, then read only immutable Git objects and enforce the selected runtime policy. */
export async function readImportSource(
  client: GitHubReadClient,
  raw: unknown,
  externalSignal: AbortSignal,
): Promise<{ snapshot: GitHubSourceSnapshot; stack: "nextjs" | "laravel" }> {
  const parsed = Selection.safeParse(raw);
  if (!parsed.success)
    throw new SourceConnectionError(
      400,
      "Choose a repository, branch or commit, and supported framework.",
    );
  const input = parsed.data;
  try { validateApplicationRoot(input.applicationRoot); }
  catch { throw new SourceConnectionError(400, "Use a relative application directory such as apps/web, without a leading or trailing slash."); }
  if (
    (input.ref !== "" && !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(input.ref)) ||
    input.ref.includes("..") ||
    input.ref.includes("//") ||
    input.ref.endsWith("/") ||
    input.ref.endsWith(".lock")
  )
    throw new SourceConnectionError(
      400,
      "Use a regular branch name or an exact commit SHA.",
    );
  const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(60000)]);
  const metadata = await client.get(
    `/repositories/${input.repositoryId}`,
    signal,
  );
  const repository = readGitHubRepository(metadata);
  // Empty selection means the repository's own default, never a guessed main branch.
  const selectedRef =
    input.ref ||
    (record(metadata) && typeof metadata.default_branch === "string"
      ? metadata.default_branch
      : "");
  if (
    !selectedRef ||
    !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(selectedRef) ||
    selectedRef.includes("..") ||
    selectedRef.includes("//") ||
    selectedRef.endsWith("/") ||
    selectedRef.endsWith(".lock")
  )
    throw new SourceConnectionError(
      409,
      "This repository has no supported default branch. Enter a branch name or exact commit ID.",
    );
  let commitId = selectedRef;
  if (!/^[a-f0-9]{40}$/.test(commitId)) {
    const ref = await client.get(
      `/repos/${repository.owner}/${repository.name}/git/ref/heads/${selectedRef}`,
      signal,
    );
    if (
      !record(ref) ||
      !record(ref.object) ||
      ref.object.type !== "commit" ||
      typeof ref.object.sha !== "string" ||
      !/^[a-f0-9]{40}$/.test(ref.object.sha)
    )
      throw new SourceConnectionError(
        409,
        "That branch could not be resolved. Choose an exact commit or another branch.",
      );
    commitId = ref.object.sha;
  }
  const snapshot = await readGitHubSnapshot(
    client,
    repository,
    commitId,
    signal,
    input.applicationRoot,
  );
  let stack: "nextjs" | "laravel";
  try {
    stack = input.stack === "auto" ? detectSourceFramework(snapshot.files) : input.stack;
    if (stack === "laravel") validateLaravelSource(snapshot.files);
    else {
      const manifest = JSON.parse(
        snapshot.files.find((file) => file.path === "package.json")?.content ??
          "null",
      ) as unknown;
      if (
        !record(manifest) ||
        !record(manifest.dependencies) ||
        typeof manifest.dependencies.next !== "string" ||
        !/^[~^]?(?:15|16)\.\d+(?:\.\d+)?$/.test(manifest.dependencies.next)
      )
        throw new Error(
          "This import runtime accepts Next.js 15 or 16 with an explicit version range. The repository version is preserved, never upgraded during import.",
        );
      validateNextjsStyling(snapshot.files);
    }
  } catch (error) {
    // Policy messages are trusted Wrenly text; arbitrary parser/source details stay private.
    if (error instanceof SyntaxError)
      throw new SourceConnectionError(
        400,
        "The repository has an invalid package manifest.",
      );
    throw new SourceConnectionError(
      400,
      error instanceof Error
        ? error.message.slice(0, 500)
        : "This source is not supported by the selected runtime.",
    );
  }
  return { snapshot, stack };
}
