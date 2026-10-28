import { readDocumentationCommunityLinks } from "./lib/community-links";
/** Validate only the optional public community destinations at startup. */
export function register(): void {
  readDocumentationCommunityLinks();
}
