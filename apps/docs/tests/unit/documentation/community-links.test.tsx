import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readDocumentationCommunityLinks } from "../../../lib/community-links";
import { DocumentationCommunityLinks } from "../../../components/documentation/community-links";
test("community destinations stay absent until configured and reject disguised links", () => {
  expect(
    renderToStaticMarkup(
      <DocumentationCommunityLinks
        links={readDocumentationCommunityLinks({})}
      />,
    ),
  ).toBe("");
  for (const value of [
    "http://github.com/example/repo",
    "https://github.com.evil.test/example",
    "https://secret@github.com/example/repo",
    "https://github.com/example?token=private",
  ])
    expect(() =>
      readDocumentationCommunityLinks({ WRENLY_DOCS_GITHUB_URL: value }),
    ).toThrow();
  expect(() =>
    readDocumentationCommunityLinks({
      WRENLY_DOCS_DISCORD_URL: "https://discord.com/channels/123",
    }),
  ).toThrow();
  const links = readDocumentationCommunityLinks({
    WRENLY_DOCS_GITHUB_URL: "https://github.com/example/project",
    WRENLY_DOCS_DISCORD_URL: "https://discord.gg/example",
  });
  const html = renderToStaticMarkup(
    <DocumentationCommunityLinks links={links} />,
  );
  expect(html).toContain('aria-label="Wrenly on GitHub"');
  expect(html).toContain('aria-label="Wrenly on Discord"');
  expect(html).toContain('rel="noopener noreferrer"');
});
