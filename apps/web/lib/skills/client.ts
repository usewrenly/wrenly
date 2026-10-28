// Reads saved Skill acknowledgements; failed confirmation does not discard a pending save.
import { z } from "zod";
import { apiFetch } from "../api";
import { SaveSchema, type SkillPending } from "./contracts";
// A slow read/save must recover without claiming an uncertain write was rejected.
const SKILL_REQUEST_TIMEOUT_MS = 20_000;

export class SkillRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SkillRequestError";
  }
}
/** Reads explicit server acknowledgements; transport/schema failures remain uncertain saves. */
export async function skillRequest<T>(
  path: `/api/${string}`,
  schema: z.ZodType<T>,
  options?: RequestInit,
): Promise<T> {
  try {
    const response = await apiFetch(path, {
      ...options, cache: "no-store",
      signal: options?.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(SKILL_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(SKILL_REQUEST_TIMEOUT_MS),
    });
    const value: unknown = await response.json();
    if (!response.ok)
      throw new SkillRequestError(
        response.status,
        typeof value === "object" &&
          value !== null &&
          "error" in value &&
          typeof value.error === "string"
          ? value.error
          : "Skills could not be loaded or saved.",
      );
    return schema.parse(value);
  } catch (error) {
    if (error instanceof SkillRequestError) throw error;
    throw new SkillRequestError(
      0,
      "The response could not be confirmed. Keep your text and check the saved change before retrying.",
    );
  }
}
/** Reuses the reviewed pending body and request identity for explicit save/recovery. */
export function sendSkillChange(
  pending: SkillPending,
): Promise<z.infer<typeof SaveSchema>> {
  return skillRequest(pending.path, SaveSchema, {
    method: pending.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pending.body),
  });
}
