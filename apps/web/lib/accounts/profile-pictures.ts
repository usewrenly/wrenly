"use client";
// Metadata reads never mutate a picture or retry a write.
import { useQuery } from "@tanstack/react-query";
export interface PictureMetadata {
  userId: string;
  revision: string | null;
  mutationId: string | null;
  url: string | null;
}
const REQUEST_TIMEOUT_MS = 10_000;
/** Reads only the signed-in account's authoritative picture identity. */
export async function readOwnPicture(userId: string, signal?: AbortSignal): Promise<PictureMetadata> {
  try {
    const response = await fetch("/api/account/profile-picture", {
      credentials: "same-origin",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const value: unknown = await response.json();
    if (
      !response.ok ||
      !value ||
      typeof value !== "object" ||
      !("userId" in value) ||
      value.userId !== userId ||
      !("revision" in value) ||
      !(value.revision === null || typeof value.revision === "string") ||
      !("mutationId" in value) ||
      !(value.mutationId === null || typeof value.mutationId === "string") ||
      !("url" in value) ||
      !(
        value.url === null ||
        (typeof value.url === "string" &&
          value.url.startsWith("/api/account/profile-picture/image?"))
      )
    )
      throw new Error(
        "Your saved picture could not be checked. Sign in again if needed.",
      );
    return { userId: value.userId, revision: value.revision, mutationId: value.mutationId, url: value.url };
  } catch {
    throw new Error("Your saved picture could not be checked. Sign in again if needed.");
  }
}
export function useOwnPicture(
  userId?: string,
  enabled = true,
): ReturnType<typeof useQuery<PictureMetadata>> {
  return useQuery<PictureMetadata>({
    queryKey: ["profile-picture", userId],
    enabled: Boolean(userId) && enabled,
    retry: false,
    queryFn: ({ signal }) => readOwnPicture(userId!, signal),
  });
}
