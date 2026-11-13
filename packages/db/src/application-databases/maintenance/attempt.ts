/** Independent restart journal. Publishing receipts are never rewritten by maintenance. */
import { z } from "zod";
const STEPS = ["broker-start", "application-start", "route-verify"] as const;
export const MaintenanceAttempt = z
  .object({
    id: z.uuid(),
    grantRevision: z.uuid(),
    claimToken: z.uuid(),
    leaseExpiresAt: z.iso.datetime(),
    status: z.enum(["running", "success", "interrupted"]),
    pending: z
      .object({ id: z.uuid(), step: z.enum(STEPS) })
      .strict()
      .nullable(),
    completed: z
      .array(
        z
          .object({
            id: z.uuid(),
            step: z.enum(STEPS),
            verifiedAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(STEPS.length),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const invalid = value.completed.some((receipt, index) => {
      const duplicate = ids.has(receipt.id);
      ids.add(receipt.id);
      return duplicate || receipt.step !== STEPS[index];
    });
    if (
      invalid ||
      (value.pending &&
        (ids.has(value.pending.id) ||
          value.pending.step !== STEPS[value.completed.length])) ||
      (value.status === "success" &&
        (value.pending || value.completed.length !== STEPS.length)) ||
      (value.status === "running" && value.completed.length === STEPS.length)
    )
      context.addIssue({
        code: "custom",
        message: "Maintenance effect history is inconsistent.",
      });
  });
export type MaintenanceAttempt = z.infer<typeof MaintenanceAttempt>;
function owned(
  raw: unknown,
  token: string,
  revision: string,
  now: Date,
): MaintenanceAttempt {
  const attempt = MaintenanceAttempt.parse(raw);
  if (
    attempt.claimToken !== z.uuid().parse(token) ||
    attempt.grantRevision !== z.uuid().parse(revision) ||
    attempt.status !== "running" ||
    Date.parse(attempt.leaseExpiresAt) <= now.getTime()
  )
    throw new Error("Maintenance claim expired or permission changed.");
  return attempt;
}
/** Persist the returned intent before starting anything. An unknown pending effect cannot be begun again. */
export function beginMaintenanceEffect(
  raw: unknown,
  token: string,
  revision: string,
  now: Date,
): MaintenanceAttempt {
  const attempt = owned(raw, token, revision, now);
  if (attempt.pending)
    throw new Error(
      "Inspect the pending maintenance effect before continuing.",
    );
  const step = STEPS[attempt.completed.length];
  if (!step) throw new Error("Maintenance is already complete.");
  return MaintenanceAttempt.parse({
    ...attempt,
    pending: { id: crypto.randomUUID(), step },
  });
}
/** The caller supplies independently verified host evidence; this transition alone proves no remote result. */
export function acknowledgeMaintenanceEffect(
  raw: unknown,
  token: string,
  revision: string,
  effectId: string,
  now: Date,
): MaintenanceAttempt {
  const attempt = owned(raw, token, revision, now);
  if (!attempt.pending || attempt.pending.id !== z.uuid().parse(effectId))
    throw new Error(
      "Maintenance acknowledgement does not match its saved effect.",
    );
  const completed = [
    ...attempt.completed,
    { ...attempt.pending, verifiedAt: now.toISOString() },
  ];
  return MaintenanceAttempt.parse({
    ...attempt,
    pending: null,
    completed,
    status: completed.length === STEPS.length ? "success" : "running",
  });
}
/** Lease loss preserves the uncertain intent; it never authorizes credential delivery again. */
export function expireMaintenanceAttempt(
  raw: unknown,
  now: Date,
): MaintenanceAttempt {
  const attempt = MaintenanceAttempt.parse(raw);
  if (
    attempt.status !== "running" ||
    Date.parse(attempt.leaseExpiresAt) > now.getTime()
  )
    return attempt;
  return MaintenanceAttempt.parse({ ...attempt, status: "interrupted" });
}
