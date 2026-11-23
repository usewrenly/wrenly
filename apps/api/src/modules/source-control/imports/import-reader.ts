import { supportsImportedVersion } from "@wrenly/source-control/framework-versions";
import {
  DEFAULT_IMPORT_LIMITS,
  type SourceImportLimits,
  type SourceImportRiskCode,
  type SourceImportRiskFlag,
} from "@wrenly/source-control";
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
import type { RevisionFile } from "@wrenly/source-control/revision";
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
const MAX_RISK_PATHS_PER_FLAG = 25;
const ALLOWED_LARAVEL_COMPOSER_CONFIG_KEYS = new Set([
  "optimize-autoloader",
  "sort-packages",
  "preferred-install",
]);
const LIFECYCLE_INSTALL_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishonly",
]);
const FORBIDDEN_TOOLING_FILE =
  /(?:^|\/)(?:composer\.phar|auth\.json|\.npmrc|bunfig\.toml)$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRiskFlag(
  flags: SourceImportRiskFlag[],
  code: SourceImportRiskCode,
  title: string,
  detail: string,
  paths: readonly string[],
): void {
  const existing = flags.find((flag) => flag.code === code);
  if (!existing) {
    flags.push({
      code,
      title,
      detail,
      paths: [...new Set(paths)].slice(0, MAX_RISK_PATHS_PER_FLAG),
    });
    return;
  }
  const merged = new Set(existing.paths);
  for (const path of paths) {
    if (merged.size >= MAX_RISK_PATHS_PER_FLAG) break;
    merged.add(path);
  }
  existing.paths = [...merged];
  if (!existing.detail.includes(detail)) {
    existing.detail = `${existing.detail} ${detail}`;
  }
}

function findMonorepoAppRoots(files: readonly RevisionFile[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const match = file.path.match(/^(.+)\/(package\.json|composer\.json)$/);
    if (!match?.[1] || !match[2]) continue;
    const dir = match[1];
    if (dir.split("/").length > 3) continue;
    try {
      const parsed: unknown = JSON.parse(file.content);
      if (!record(parsed)) continue;
      if (match[2] === "package.json") {
        const hasNext =
          (record(parsed.dependencies) &&
            typeof parsed.dependencies.next === "string") ||
          (record(parsed.devDependencies) &&
            typeof parsed.devDependencies.next === "string");
        if (hasNext) roots.add(dir);
      } else if (
        record(parsed.require) &&
        typeof parsed.require["laravel/framework"] === "string"
      ) {
        roots.add(dir);
      }
    } catch {
      // Ignore invalid nested JSON manifests during discovery.
    }
  }
  return [...roots].sort().slice(0, 6);
}

function measureSnapshotBytes(files: readonly RevisionFile[]): {
  textBytes: number;
  assetBytes: number;
  totalBytes: number;
} {
  let textBytes = 0;
  let assetBytes = 0;
  for (const file of files) {
    if (file.asset) assetBytes += file.asset.byteLength;
    else textBytes += Buffer.byteLength(file.content);
  }
  return { textBytes, assetBytes, totalBytes: textBytes + assetBytes };
}

function isFloatingCurrentNextjsTag(version: string): boolean {
  const normalized = version.trim().toLowerCase();
  return normalized === "latest" || normalized === "next";
}

function isOlderNextjsVersion(version: string): boolean {
  return /^[\^~]?\s*(?:0|1[0-4])(?:\.|$)/.test(version.trim());
}

/** Resolve a branch once, then read only immutable Git objects and enforce the selected runtime policy. */
export async function readImportSource(
  client: GitHubReadClient,
  raw: unknown,
  externalSignal: AbortSignal,
  limits: SourceImportLimits = DEFAULT_IMPORT_LIMITS,
  options: { allowRiskReview?: boolean } = {},
): Promise<{
  snapshot: GitHubSourceSnapshot;
  stack: "nextjs" | "laravel";
  riskFlags: SourceImportRiskFlag[];
}> {
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
  const allowRiskReview = options.allowRiskReview === true;
  const signal = AbortSignal.any([
    externalSignal,
    AbortSignal.timeout(allowRiskReview ? 180_000 : 60_000),
  ]);
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
    limits,
    {
      interactiveReview: allowRiskReview,
      beforeReadBlobs:
        allowRiskReview && input.applicationRoot === ""
          ? async (entries, readBlobText) => {
              if (entries.some((entry) => entry.path === "composer.json")) {
                return;
              }
              const rootPkg = entries.find(
                (entry) => entry.path === "package.json",
              );
              if (rootPkg) {
                try {
                  const parsed: unknown = JSON.parse(
                    await readBlobText(rootPkg),
                  );
                  if (
                    record(parsed) &&
                    ((record(parsed.dependencies) &&
                      typeof parsed.dependencies.next === "string") ||
                      (record(parsed.devDependencies) &&
                        typeof parsed.devDependencies.next === "string"))
                  ) {
                    return;
                  }
                } catch {
                  // Fall through to nested monorepo discovery.
                }
              }
              const manifestEntries = entries
                .filter((entry) => {
                  const match = entry.path.match(
                    /^(.+)\/(package\.json|composer\.json)$/,
                  );
                  return Boolean(
                    match?.[1] && match[1].split("/").length <= 3,
                  );
                })
                .slice(0, 16);
              const discoveredRoots = new Set<string>();
              await Promise.all(
                manifestEntries.map(async (entry) => {
                  const match = entry.path.match(
                    /^(.+)\/(package\.json|composer\.json)$/,
                  );
                  if (!match?.[1] || !match[2]) return;
                  try {
                    const parsed: unknown = JSON.parse(
                      await readBlobText(entry),
                    );
                    if (!record(parsed)) return;
                    if (match[2] === "package.json") {
                      const hasNext =
                        (record(parsed.dependencies) &&
                          typeof parsed.dependencies.next === "string") ||
                        (record(parsed.devDependencies) &&
                          typeof parsed.devDependencies.next === "string");
                      if (hasNext) discoveredRoots.add(match[1]);
                    } else if (
                      record(parsed.require) &&
                      typeof parsed.require["laravel/framework"] === "string"
                    ) {
                      discoveredRoots.add(match[1]);
                    }
                  } catch {
                    // Ignore unreadable nested manifests.
                  }
                }),
              );
              const candidates = [...discoveredRoots].sort().slice(0, 6);
              if (candidates.length > 0) {
                throw new SourceConnectionError(
                  400,
                  `No Next.js or Laravel app manifest was found at the repository root. This looks like a monorepo — set Application directory to: ${candidates.join(", ")}.`,
                );
              }
              if (entries.length > 40) {
                throw new SourceConnectionError(
                  400,
                  "No Next.js or Laravel app manifest (package.json with next, or composer.json with laravel/framework) was found at the repository root. Enter an Application directory or verify the repository contains a supported framework.",
                );
              }
            }
          : undefined,
    },
  );
  const riskFlags: SourceImportRiskFlag[] = (snapshot.riskFlags ?? []).map(
    (flag) => ({ ...flag, paths: [...flag.paths] }),
  );
  let stack: "nextjs" | "laravel";
  let files: RevisionFile[] = snapshot.files.map((file) => ({ ...file }));
  const excludedPaths = [...snapshot.excludedPaths];

  try {
    try {
      stack =
        input.stack === "auto" ? detectSourceFramework(files) : input.stack;
    } catch (error) {
      if (allowRiskReview && input.applicationRoot === "") {
        const candidates = findMonorepoAppRoots(files);
        if (candidates.length > 0) {
          throw new Error(
            `No Next.js or Laravel app manifest was found at the repository root. Try setting Application directory to: ${candidates.join(", ")}.`,
            { cause: error },
          );
        }
      }
      throw error;
    }

    if (stack === "laravel") {
      if (allowRiskReview) {
        const sanitized: RevisionFile[] = [];
        const removedToolingPaths: string[] = [];

        for (const file of files) {
          if (FORBIDDEN_TOOLING_FILE.test(file.path)) {
            excludedPaths.push(file.path);
            removedToolingPaths.push(file.path);
            continue;
          }

          if (file.path === ".env.example" && /^\s*APP_KEY\s*=/m.test(file.content)) {
            const hasPrefilledKey = /^\s*APP_KEY\s*=\s*[^\s#'"]/m.test(
              file.content,
            );
            if (hasPrefilledKey) {
              mergeRiskFlag(
                riskFlags,
                "private_env",
                "Pre-filled APP_KEY in .env.example",
                "Removed the APP_KEY line from .env.example so runtime deployments inject fresh application secrets.",
                [".env.example"],
              );
            }
            sanitized.push({
              ...file,
              content: file.content.replace(/^\s*APP_KEY\s*=.*(?:\r?\n|$)/gm, ""),
            });
            continue;
          }

          if (file.path === "composer.json") {
            const parsed: unknown = JSON.parse(file.content);
            if (!record(parsed)) {
              sanitized.push(file);
              continue;
            }
            const nextComposer: Record<string, unknown> = { ...parsed };
            let strippedComposerPolicy = false;
            if ("scripts" in nextComposer) {
              delete nextComposer.scripts;
              strippedComposerPolicy = true;
            }
            if ("repositories" in nextComposer) {
              delete nextComposer.repositories;
              strippedComposerPolicy = true;
            }
            if ("config" in nextComposer && record(nextComposer.config)) {
              const filteredConfig: Record<string, unknown> = {};
              for (const [key, val] of Object.entries(nextComposer.config)) {
                if (ALLOWED_LARAVEL_COMPOSER_CONFIG_KEYS.has(key)) {
                  filteredConfig[key] = val;
                } else {
                  strippedComposerPolicy = true;
                }
              }
              if (Object.keys(filteredConfig).length > 0) {
                nextComposer.config = filteredConfig;
              } else {
                delete nextComposer.config;
              }
            }
            if (strippedComposerPolicy) {
              mergeRiskFlag(
                riskFlags,
                "package_scripts",
                "Composer scripts or policy overrides",
                "Composer scripts, custom repositories, and plugin overrides were omitted to keep isolated sandbox installs safe.",
                ["composer.json"],
              );
            }
            sanitized.push({
              ...file,
              content: `${JSON.stringify(nextComposer, null, 2)}\n`,
            });
            continue;
          }

          if (file.path === "package.json") {
            const parsed: unknown = JSON.parse(file.content);
            if (!record(parsed)) {
              sanitized.push(file);
              continue;
            }
            const nextPkg: Record<string, unknown> = { ...parsed };
            let modifiedPkg = false;
            if ("trustedDependencies" in nextPkg) {
              delete nextPkg.trustedDependencies;
              modifiedPkg = true;
            }
            if ("workspaces" in nextPkg) {
              delete nextPkg.workspaces;
              modifiedPkg = true;
            }
            const scripts = record(nextPkg.scripts) ? nextPkg.scripts : null;
            const buildScript =
              scripts && typeof scripts.build === "string"
                ? scripts.build
                : null;
            if (
              scripts &&
              Object.keys(scripts).some((scriptName) => scriptName !== "build")
            ) {
              modifiedPkg = true;
            }
            if (buildScript !== null) {
              nextPkg.scripts = { build: buildScript };
              if (modifiedPkg) {
                mergeRiskFlag(
                  riskFlags,
                  "package_scripts",
                  "Non-build package scripts",
                  "Package scripts outside build (such as dev or postinstall hooks) were stripped for sandbox execution.",
                  ["package.json"],
                );
              }
              sanitized.push({
                ...file,
                content: `${JSON.stringify(nextPkg, null, 2)}\n`,
              });
            } else {
              excludedPaths.push("package.json");
              mergeRiskFlag(
                riskFlags,
                "package_scripts",
                "Package manifest without build script",
                "Excluded package.json because it does not define an offline build script.",
                ["package.json"],
              );
            }
            continue;
          }

          sanitized.push(file);
        }

        if (removedToolingPaths.length > 0) {
          mergeRiskFlag(
            riskFlags,
            "private_env",
            "Package tooling credentials or overrides",
            "Removed package credentials or tooling overrides (.npmrc, auth.json, composer.phar, bunfig.toml).",
            removedToolingPaths,
          );
        }

        if (
          sanitized.some((f) => f.path === "composer.json") &&
          sanitized.some((f) => f.path === "artisan")
        ) {
          const addedCompat: string[] = [];
          if (!sanitized.some((f) => f.path === "bootstrap/providers.php")) {
            sanitized.push({
              path: "bootstrap/providers.php",
              content:
                "<?php\n\nreturn [\n    App\\Providers\\AppServiceProvider::class,\n];\n",
            });
            addedCompat.push("bootstrap/providers.php");
          }
          if (!sanitized.some((f) => f.path === "routes/console.php")) {
            sanitized.push({
              path: "routes/console.php",
              content: "<?php\n",
            });
            addedCompat.push("routes/console.php");
          }
          if (addedCompat.length > 0) {
            mergeRiskFlag(
              riskFlags,
              "unverified_version",
              "Missing standard Laravel bootstrap/console files",
              "Generated default Laravel 12/13 stubs for missing bootstrap or console files during review.",
              addedCompat,
            );
          }
        }
        files = sanitized;
      }

      validateLaravelSource(files);
    } else {
      const manifest = JSON.parse(
        files.find((file) => file.path === "package.json")?.content ??
          "null",
      ) as unknown;
      const nextVersion =
        record(manifest) &&
        record(manifest.dependencies) &&
        typeof manifest.dependencies.next === "string"
          ? manifest.dependencies.next
          : record(manifest) &&
              record(manifest.devDependencies) &&
              typeof manifest.devDependencies.next === "string"
            ? manifest.devDependencies.next
            : null;
      if (nextVersion === null) {
        if (allowRiskReview && input.applicationRoot === "") {
          const candidates = findMonorepoAppRoots(files);
          if (candidates.length > 0) {
            throw new Error(
              `package.json at the repository root does not depend on Next.js. Try setting Application directory to: ${candidates.join(", ")}.`,
            );
          }
        }
        throw new Error(
          "This import runtime accepts Next.js 15 or 16 with an explicit version range. The repository version is preserved, never upgraded during import.",
        );
      }
      if (!supportsImportedVersion("nextjs", nextVersion)) {
        if (allowRiskReview) {
          if (!isFloatingCurrentNextjsTag(nextVersion)) {
            const olderMajor = isOlderNextjsVersion(nextVersion);
            mergeRiskFlag(
              riskFlags,
              "unverified_version",
              olderMajor
                ? "Older Next.js version"
                : "Unpinned or preview Next.js version",
              olderMajor
                ? `Repository declares next@${nextVersion}. Wrenly's validated sandbox targets Next.js 15 or 16; review and consent before importing.`
                : `Repository declares next@${nextVersion}, which is not a fixed Next.js 15 or 16 range. Review and consent if you want to import it as-is.`,
              ["package.json"],
            );
          }
        } else {
          throw new Error(
            "This import runtime accepts Next.js 15 or 16 with an explicit version range. The repository version is preserved, never upgraded during import.",
          );
        }
      }
      if (allowRiskReview && record(manifest) && record(manifest.scripts)) {
        const riskyHooks = Object.keys(manifest.scripts).filter((scriptName) =>
          LIFECYCLE_INSTALL_SCRIPTS.has(scriptName),
        );
        if (riskyHooks.length > 0) {
          mergeRiskFlag(
            riskFlags,
            "package_scripts",
            "Package lifecycle install hooks",
            `package.json defines lifecycle hooks (${riskyHooks.join(", ")}) that may be restricted in isolated builds.`,
            ["package.json"],
          );
        }
      }
      try {
        validateNextjsStyling(files);
      } catch (stylingError) {
        if (allowRiskReview) {
          mergeRiskFlag(
            riskFlags,
            "unverified_version",
            "Non-standard Next.js styling configuration",
            stylingError instanceof Error
              ? stylingError.message
              : "Styling setup differs from the standard Next.js 15/16 Tailwind layout.",
            ["package.json"],
          );
        } else {
          throw stylingError;
        }
      }
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
  const measured = measureSnapshotBytes(files);
  const updatedSnapshot: GitHubSourceSnapshot = {
    ...snapshot,
    files,
    excludedPaths,
    textBytes: measured.textBytes,
    assetBytes: measured.assetBytes,
    totalBytes: measured.totalBytes,
    riskFlags,
  };
  return { snapshot: updatedSnapshot, stack, riskFlags };
}
