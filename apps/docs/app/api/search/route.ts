// Index only compiled public guides, with bounded input.
import { createFromSource } from "fumadocs-core/search/server";
const MAX_SEARCH_CHARACTERS = 200;
let search: ReturnType<typeof createFromSource> | undefined;
export async function GET(request: Request): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams.get("query") ?? "";
    if (query.length > MAX_SEARCH_CHARACTERS)
      return Response.json(
        { message: "Use a shorter search." },
        { status: 400 },
      );
    if (!query.trim()) return Response.json([]);
    const { source } = await import("../../../lib/source");
    search ??= createFromSource(source);
    return await search.GET(request);
  } catch {
    return Response.json(
      { message: "Search is unavailable. You can still browse the guides." },
      { status: 503 },
    );
  }
}
