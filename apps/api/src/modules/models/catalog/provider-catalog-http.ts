/**
 * Authenticated catalog HTTP boundary.
 * Browsing returns local metadata; refresh requires the instance owner and trusted origin.
 * No token, prompt or cookie is sent to the public registry.
 */
import { z } from "zod";
import type { AvailableCatalog } from "./provider-catalog-store";
import { CatalogAccessError } from "./provider-catalog-store";
const HEADERS = { "Cache-Control": "no-store, private" };
const Query = z.object({
  q: z.string().max(200).default(""),
  provider: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  compatible: z.enum(["true", "false"]).default("false"),
});
export interface CatalogHandlers {
  search: (request: Request) => Promise<Response>;
  refresh: (request: Request) => Promise<Response>;
}
/** Serves bounded searchable metadata and a separate owner-authorized refresh action. */
export function createCatalogHandlers(dependencies: {
  webUrl: string;
  session: (headers: Headers) => Promise<string | null>;
  catalog: () => Promise<AvailableCatalog>;
  refresh: (actorId: string) => Promise<unknown>;
}): CatalogHandlers {
  const failure = (error: unknown): Response =>
    error instanceof CatalogAccessError
      ? Response.json(
          { error: error.message },
          { status: error.status, headers: HEADERS },
        )
      : Response.json(
          { error: "The model catalog is unavailable. Try again." },
          { status: 503, headers: HEADERS },
        );
  return {
    search: async (request) => {
      try {
        if (!(await dependencies.session(request.headers)))
          return Response.json(
            { error: "Sign in to browse the model catalog." },
            { status: 401, headers: HEADERS },
          );
        const query = Query.safeParse(
          Object.fromEntries(new URL(request.url).searchParams),
        );
        if (!query.success)
          return Response.json(
            { error: "Provide valid catalog search and pagination values." },
            { status: 400, headers: HEADERS },
          );
        const {
          q,
          provider: providerId,
          compatible,
          offset,
          limit,
        } = query.data;
        const available = await dependencies.catalog(),
          term = q.trim().toLowerCase();
        const matches = (value: string): boolean =>
          value.toLowerCase().includes(term);
        const providers = available.snapshot.providers.filter(
          (provider) =>
            (!providerId || provider.id === providerId) &&
            (compatible !== "true" ||
              provider.compatibility === "openai-compatible") &&
            (providerId ||
              matches(provider.id) ||
              matches(provider.name) ||
              provider.models.some(
                (model) => matches(model.id) || matches(model.name),
              )),
        );
        const selected = providerId ? providers[0] : undefined;
        const models =
          selected?.models.filter(
            (model) =>
              matches(model.id) ||
              matches(model.name) ||
              Boolean(model.canonicalId && matches(model.canonicalId)),
          ) ?? [];
        return Response.json(
          {
            source: available.snapshot.source,
            version: available.snapshot.version,
            fetchedAt: available.snapshot.fetchedAt,
            origin: available.origin,
            stale: available.stale,
            cacheUnavailable: available.cacheUnavailable,
            totalProviders: providers.length,
            totalModels: models.length,
            providers: (providerId
              ? providers
              : providers.slice(offset, offset + limit)
            ).map(({ models: entries, ...metadata }) => ({
              ...metadata,
              modelCount: entries.length,
            })),
            models: models.slice(offset, offset + limit),
            offset,
            limit,
          },
          { headers: HEADERS },
        );
      } catch (error) {
        return failure(error);
      }
    },
    refresh: async (request) => {
      try {
        if (
          request.headers.get("origin") !== new URL(dependencies.webUrl).origin
        )
          return Response.json(
            { error: "Open catalog refresh from the trusted web address." },
            { status: 403, headers: HEADERS },
          );
        const actorId = await dependencies.session(request.headers);
        if (!actorId)
          return Response.json(
            { error: "Sign in to refresh the model catalog." },
            { status: 401, headers: HEADERS },
          );
        return Response.json(await dependencies.refresh(actorId), {
          headers: HEADERS,
        });
      } catch (error) {
        return failure(error);
      }
    },
  };
}
