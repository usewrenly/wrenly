// Reports confirmed execution steps, not private model reasoning.
export interface BuildActivity {
  sequence: number;
  attempt: number;
  operation: "generation" | "source" | "installation" | "validation";
  state: "started" | "completed" | "failed";
  occurredAt: string;
}
// Keep progress history bounded while retaining recent execution steps.
export const MAX_ACTIVITY_EVENTS = 64;
/** Rejects malformed progress before presenting it as verified execution. */
export function parseBuildActivity(value: unknown): BuildActivity[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ACTIVITY_EVENTS)
    throw new Error("Execution activity is unreadable.");
  let sequence = 0;
  return value.map((entry: unknown): BuildActivity => {
    if (!entry || typeof entry !== "object")
      throw new Error("Invalid execution activity.");
    const row = entry as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.sequence) ||
      Number(row.sequence) <= sequence ||
      !Number.isInteger(row.attempt) ||
      Number(row.attempt) < 1 ||
      Number(row.attempt) > 3 ||
      !["generation", "source", "installation", "validation"].includes(
        String(row.operation),
      ) ||
      !["started", "completed", "failed"].includes(String(row.state)) ||
      typeof row.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(row.occurredAt))
    )
      throw new Error("Invalid execution activity.");
    sequence = Number(row.sequence);
    return {
      sequence,
      attempt: Number(row.attempt),
      operation: row.operation as BuildActivity["operation"],
      state: row.state as BuildActivity["state"],
      occurredAt: row.occurredAt,
    };
  });
}
