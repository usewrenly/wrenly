// Validates exact owner-reviewed HTTPS media origins, never arbitrary CSP or browsing permissions.
import { z } from "zod";
// Suggestions only; every additional origin still needs explicit owner approval.
export const PREVIEW_MEDIA_ORIGINS = [
  "https://images.unsplash.com",
  "https://images.pexels.com",
  "https://videos.pexels.com",
] as const;
const MAX_MEDIA_ORIGINS = 12;
const MAX_MEDIA_ORIGIN_LENGTH = 280;
const MediaOrigin = z.string().max(MAX_MEDIA_ORIGIN_LENGTH).refine((value) => {
  try {
    const url = new URL(value), host = url.hostname;
    return url.protocol === "https:" && value === url.origin && !url.username && !url.password && !url.port &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && host.includes(".") &&
      !/^[0-9.]+$/.test(host) && !host.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-")) &&
      !["localhost", "local", "internal", "lan", "invalid", "test"].some(suffix => host === suffix || host.endsWith("." + suffix)) && !host.endsWith(".home.arpa");
  } catch { return false; }
}, "Use an exact public HTTPS origin without a path, credentials or custom port.");
// These are browser media requests, never server fetch targets. Hostname syntax cannot prove DNS ownership or routing.
export const MediaOrigins = z.array(MediaOrigin).max(MAX_MEDIA_ORIGINS).refine(
  values => new Set(values).size === values.length, "Choose each host once.",
);
export const PreviewMediaInput = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z.string().uuid(),
    origins: MediaOrigins,
  })
  .strict();
export class PreviewMediaError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "PreviewMediaError";
  }
}
