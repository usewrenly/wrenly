// Help targets never grant authority or leak developer paths.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readDocumentationBase } from "./documentation-url";
import { DocumentationLink } from "../components/documentation-link";
test("documentation URL has a local development default and no invented production domain", () => {
  expect(readDocumentationBase(undefined, "development")).toBe(
    "http://localhost:3001/docs",
  );
  expect(readDocumentationBase(undefined, "production")).toBeNull();
  expect(
    readDocumentationBase("https://help.example.test/docs/", "production"),
  ).toBe("https://help.example.test/docs");
  expect(
    readDocumentationBase("http://192.168.1.5:3001/docs", "production"),
  ).toBe("http://192.168.1.5:3001/docs");
});
test("help targets reject credentials, query, fragment and active schemes", () => {
  for (const value of [
    "javascript:alert(1)",
    "https://user:pass@example.test/docs",
    "https://example.test/docs?secret=value",
    "https://example.test/docs#private",
    "http://example.com/docs",
    "http://10.attacker.test/docs",
    "http://192.168.attacker.test/docs",
    "https://example.test/",
    "not a URL",
  ]) {
    expect(() => readDocumentationBase(value, "production")).toThrow(
      "NEXT_PUBLIC_DOCS_URL",
    );
  }
});
test("shared link renders a public guide or an explicit unconfigured state", () => {
  const previous = process.env.NEXT_PUBLIC_DOCS_URL;
  try {
    process.env.NEXT_PUBLIC_DOCS_URL = "https://help.example.test/docs";
    const html = renderToStaticMarkup(
      <DocumentationLink guide="guides/instance-setup" />,
    );
    expect(html).toContain(
      'href="https://help.example.test/docs/guides/instance-setup"',
    );
    expect(html).toContain("See docs →");
    expect(html).not.toContain("design-map");
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_DOCS_URL;
    else process.env.NEXT_PUBLIC_DOCS_URL = previous;
  }
});
