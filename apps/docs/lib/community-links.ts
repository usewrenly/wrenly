// Validate optional docs destinations without contacting those services.
import { z } from "zod";
import type { CommunityLinks } from "../components/documentation/community-links";
const safeUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !url.port
  );
}, "Use an HTTPS community address without credentials, a query or fragment.");
const schema = z.object({
  WRENLY_DOCS_GITHUB_URL: safeUrl
    .refine(
      (value) => new URL(value).hostname === "github.com",
      "Use your github.com organization or repository URL.",
    )
    .optional(),
  WRENLY_DOCS_DISCORD_URL: safeUrl
    .refine((value) => {
      const url = new URL(value);
      return (
        (url.hostname === "discord.gg" && /^\/[\w-]+\/?$/.test(url.pathname)) ||
        (url.hostname === "discord.com" &&
          /^\/invite\/[\w-]+\/?$/.test(url.pathname))
      );
    }, "Use a discord.gg or discord.com/invite community link.")
    .optional(),
});
export function readDocumentationCommunityLinks(
  env: Record<string, string | undefined> = process.env,
): CommunityLinks {
  const parsed = schema.safeParse({
    WRENLY_DOCS_GITHUB_URL: env.WRENLY_DOCS_GITHUB_URL || undefined,
    WRENLY_DOCS_DISCORD_URL: env.WRENLY_DOCS_DISCORD_URL || undefined,
  });
  if (!parsed.success)
    throw new Error(
      "Invalid WRENLY_DOCS_GITHUB_URL or WRENLY_DOCS_DISCORD_URL. Use the documented HTTPS community destinations.",
    );
  return {
    github: parsed.data.WRENLY_DOCS_GITHUB_URL,
    discord: parsed.data.WRENLY_DOCS_DISCORD_URL,
  };
}
