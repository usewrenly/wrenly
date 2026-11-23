/** Independent restart journal. Publishing receipts are never rewritten by maintenance. */
import { z } from "zod";
export const MAINTENANCE_STEPS = [
  "broker-start",
  "application-start",
  "route-verify",
] as const;
export const STOP_MAINTENANCE_STEPS = [
  "application-stop",
  "broker-stop",
  "verify-stopped",
] as const;
export const INSPECT_MAINTENANCE_STEPS = [
  "broker-inspect",
  "application-inspect",
  "route-inspect",
] as const;
export const ALL_MAINTENANCE_STEPS = [
  ...MAINTENANCE_STEPS,
  ...STOP_MAINTENANCE_STEPS,
  ...INSPECT_MAINTENANCE_STEPS,
] as const;
export const MaintenanceAttempt = z
  .object({
    id: z.uuid(),
    grantRevision: z.uuid(),
    claimToken: z.uuid(),
    leaseExpiresAt: z.iso.datetime(),
    status: z.enum(["running", "success", "interrupted", "reconciled"]),
    control: z
      .object({
        kind: z.enum(["stop", "inspect"]),
        actorId: z.string().min(1),
        sessionId: z.string().min(1),
        accountRevision: z.uuid(),
        accessRevision: z.uuid(),
        requestIdentity: z.string().regex(/^[a-f0-9]{64}$/),
        originals: z.array(z.uuid()).max(16),
      })
      .strict()
      .optional(),
    resolution: z
      .object({
        controlId: z.uuid(),
        outcome: z.enum(["ready", "stopped"]),
        verifiedAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
    pending: z
      .object({ id: z.uuid(), step: z.enum(ALL_MAINTENANCE_STEPS) })
      .strict()
      .nullable(),
    completed: z
      .array(
        z
          .object({
            id: z.uuid(),
            step: z.enum(ALL_MAINTENANCE_STEPS),
            verifiedAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(MAINTENANCE_STEPS.length),
  })
  .strict()
  .superRefine((value, context) => {
    const steps =
      value.control?.kind === "stop"
        ? STOP_MAINTENANCE_STEPS
        : value.control?.kind === "inspect"
          ? INSPECT_MAINTENANCE_STEPS
          : MAINTENANCE_STEPS;
    const ids = new Set<string>();
    const invalid = value.completed.some((receipt, index) => {
      const duplicate = ids.has(receipt.id);
      ids.add(receipt.id);
      return duplicate || receipt.step !== steps[index];
    });
    if (
      invalid ||
      (value.status === "reconciled") !== (value.resolution !== undefined) ||
      (value.pending &&
        (ids.has(value.pending.id) ||
          value.pending.step !== steps[value.completed.length])) ||
      (value.status === "success" &&
        (value.pending ||
          value.completed.length !== MAINTENANCE_STEPS.length)) ||
      (value.status === "running" &&
        value.completed.length === MAINTENANCE_STEPS.length)
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
  const steps =
    attempt.control?.kind === "stop"
      ? STOP_MAINTENANCE_STEPS
      : attempt.control?.kind === "inspect"
        ? INSPECT_MAINTENANCE_STEPS
        : MAINTENANCE_STEPS;
  const step = steps[attempt.completed.length];
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
    status:
      completed.length === MAINTENANCE_STEPS.length ? "success" : "running",
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
