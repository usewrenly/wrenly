// Optional public help never determines access to the instance.
/** Validates the operator's docs entry URL without inventing a production domain. */
export function readDocumentationBase(
  value: string | undefined,
  mode: string | undefined,
): string | null {
  if (!value)
    return mode === "development" || mode === "test"
      ? "http://localhost:3001/docs"
      : null;
  try {
    const url = new URL(value);
    const host = url.hostname;
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
    const local =
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "[::1]" ||
      (ipv4 &&
        (/^127\./.test(host) ||
          /^10\./.test(host) ||
          /^192\.168\./.test(host) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(host)));
    if (
      value !== value.trim() ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.replace(/\/$/, "").endsWith("/docs") ||
      !(url.protocol === "https:" || (url.protocol === "http:" && local))
    )
      throw new Error("Invalid docs URL");
    return value.replace(/\/$/, "");
  } catch {
    throw new Error(
      "NEXT_PUBLIC_DOCS_URL must be an HTTPS docs entry URL ending in /docs, without credentials, query or fragment. Local development origins may use HTTP.",
    );
  }
}

/** Builds product help links from one public configuration, never a developer file path. */
export function documentationHref(guide = ""): string | null {
  const base = readDocumentationBase(
    process.env.NEXT_PUBLIC_DOCS_URL,
    process.env.NODE_ENV,
  );
  if (!/^[a-z0-9/-]*$/.test(guide) || guide.startsWith("/"))
    throw new Error("Invalid documentation guide");
  return base ? `${base}${guide ? `/${guide}` : ""}` : null;
}
