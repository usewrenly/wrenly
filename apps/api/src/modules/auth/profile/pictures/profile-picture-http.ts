/**
 * Authenticated profile-picture HTTP boundary.
 * Authorizes identity and trusted origin before reading bounded uploads or spending decoder resources.
 * Explicit revision/mutation identities preserve uncertain-save recovery; bytes are served only through authorized no-store routes.
 */
import { AccessDeniedError } from "../../access/access-policy";
import { z } from "zod";
import { logger } from "../../../../lib/logger";
import {
  PictureMutationSchema,
  type PictureMetadata,
  type PictureMutation,
} from "./profile-picture-store";
import {
  ProfilePictureError,
  readPictureBytes,
} from "./profile-picture-policy";
const HEADERS = { "Cache-Control": "no-store, private" };
const ImageQuery = z.object({
  userId: z.string().min(1).max(200),
  revision: z.string().uuid(),
});
export interface ProfilePictureHandlers {
  metadata: (request: Request) => Promise<Response>;
  image: (request: Request) => Promise<Response>;
  save: (request: Request) => Promise<Response>;
  remove: (request: Request) => Promise<Response>;
}
/** Keeps native auth identity and origin validation ahead of all image operations. */
export function createProfilePictureHandlers(dependencies: {
  webUrl: string;
  session: (headers: Headers) => Promise<string | null>;
  metadata: (actorId: string) => Promise<PictureMetadata>;
  image: (
    actorId: string,
    targetId: string,
    revision: string,
  ) => Promise<Uint8Array>;
  decode: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
  save: (
    actorId: string,
    input: PictureMutation,
    bytes: Uint8Array | null,
  ) => Promise<PictureMetadata>;
}): ProfilePictureHandlers {
  let uploading = false;
  const handle =
    (kind: keyof ProfilePictureHandlers) =>
    async (request: Request): Promise<Response> => {
      let ownsUpload = false;
      try {
        if (
          (kind === "save" || kind === "remove") &&
          request.headers.get("origin") !== new URL(dependencies.webUrl).origin
        )
          throw new ProfilePictureError(
            403,
            "Open your profile from this instance’s trusted web address.",
          );
        const actor = await dependencies.session(request.headers);
        if (!actor)
          throw new ProfilePictureError(
            401,
            "Sign in to view or change profile pictures.",
          );
        if (kind === "metadata")
          return Response.json(await dependencies.metadata(actor), {
            headers: HEADERS,
          });
        if (kind === "image") {
          const parsed = ImageQuery.safeParse(
            Object.fromEntries(new URL(request.url).searchParams),
          );
          if (!parsed.success)
            throw new ProfilePictureError(404, "Picture unavailable.");
          const bytes = await dependencies.image(
            actor,
            parsed.data.userId,
            parsed.data.revision,
          );
          return new Response(Buffer.from(bytes), {
            headers: {
              ...HEADERS,
              "Content-Type": "image/webp",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "default-src 'none'; sandbox",
              "Cross-Origin-Resource-Policy": "same-origin",
            },
          });
        }
        const input = PictureMutationSchema.safeParse({
          mutationId: request.headers.get("idempotency-key"),
          expectedRevision: new URL(request.url).searchParams.get(
            "expectedRevision",
          ),
        });
        if (!input.success)
          throw new ProfilePictureError(
            400,
            "Provide a valid picture request and current revision.",
          );
        let bytes: Uint8Array | null = null;
        if (kind === "save") {
          if (
            !["image/png", "image/jpeg", "image/webp"].includes(
              request.headers.get("content-type")?.split(";")[0] ?? "",
            )
          )
            throw new ProfilePictureError(
              400,
              "Choose a static PNG, JPEG or WebP picture.",
            );
          if (uploading)
            throw new ProfilePictureError(
              503,
              "Another picture is being processed. Try again shortly.",
            );
          uploading = true;
          ownsUpload = true;
          bytes = await dependencies.decode(
            await readPictureBytes(request.body),
            request.signal,
          );
        }
        return Response.json(
          await dependencies.save(actor, input.data, bytes),
          { headers: HEADERS },
        );
      } catch (error) {
        if (error instanceof AccessDeniedError)
          return Response.json(
            { error: error.message },
            { status: 401, headers: HEADERS },
          );
        if (error instanceof ProfilePictureError)
          return Response.json(
            { error: error.message },
            { status: error.status, headers: HEADERS },
          );
        logger.error("Profile picture operation failed", {
          operation: kind,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        return Response.json(
          {
            error:
              "Your picture could not be read or saved. Check its saved state before trying another change.",
          },
          { status: 503, headers: HEADERS },
        );
      } finally {
        if (ownsUpload) uploading = false;
      }
    };
  return {
    metadata: handle("metadata"),
    image: handle("image"),
    save: handle("save"),
    remove: handle("remove"),
  };
}
