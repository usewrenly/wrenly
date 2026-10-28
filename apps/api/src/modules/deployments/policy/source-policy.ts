/**
 * Publishing source policy.
 * Used at admission and again during execution to validate and digest the exact saved revision.
 * Rejects unsafe/private source before host Git transport or isolated runtime packaging.
 */
// Reject the entire snapshot before writing to disk; generated ignore files must
// never decide which confidential files are allowed to leave the instance.
import { createHash } from "node:crypto";
import { validateFilePaths } from "@wrenly/sandbox/file-paths";
import { z } from "zod";

const MAX_FILES = 1000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_PATH_BYTES = 1024;
const FilesSchema = z
  .array(
    z
      .object({
        path: z.string().min(1).max(MAX_PATH_BYTES),
        content: z.string(),
      })
      .strict(),
  )
  .min(1)
  .max(MAX_FILES);
const PRIVATE_NAMES = new Set([
  ".git",
  ".gitmodules",
  ".gitconfig",
  ".netrc",
  ".ssh",
  ".aws",
  ".docker",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
]);
const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

/** Returns a bounded canonical snapshot and digest, never silently filters confidential files. */
export function validateDeploymentSource(input: unknown): {
  files: Array<{ path: string; content: string }>;
  sha256: string;
} {
  const parsed = FilesSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      "Deployment source is missing, invalid or exceeds file limits.",
    );
  validateFilePaths(parsed.data);
  let bytes = 0;
  const caseFolded = new Set<string>();
  for (const file of parsed.data) {
    bytes += Buffer.byteLength(file.path) + Buffer.byteLength(file.content);
    if (Buffer.byteLength(file.path) > MAX_PATH_BYTES)
      throw new Error("Deployment source contains an oversized file path.");
    const normalized = file.path.toLowerCase();
    if (
      normalized.split("/").includes(".npmrc") &&
      file.content.trim() !== "legacy-peer-deps=true"
    )
      throw new Error(
        "Deployment source contains private package manager configuration.",
      );
    if (caseFolded.has(normalized))
      throw new Error("Deployment source contains ambiguous file paths.");
    caseFolded.add(normalized);
    if (bytes > MAX_SOURCE_BYTES)
      throw new Error("Deployment source exceeds its byte limit.");
    if (
      normalized
        .split("/")
        .some(
          (segment) =>
            PRIVATE_NAMES.has(segment) ||
            ((segment === ".env" || segment.startsWith(".env.")) &&
              segment !== ".env.example") ||
            /\.(?:pem|key|p12|pfx)$/.test(segment),
        ) ||
      PRIVATE_KEY_MARKER.test(file.content)
    )
      throw new Error(
        "Deployment source contains a private configuration file or private key. Configure runtime secrets separately.",
      );
  }
  validateFilePaths(
    parsed.data.map((file) => ({ path: file.path.toLowerCase() })),
  );
  const files = [...parsed.data].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    files,
    sha256: createHash("sha256")
      .update(JSON.stringify(files.map((file) => [file.path, file.content])))
      .digest("hex"),
  };
}
