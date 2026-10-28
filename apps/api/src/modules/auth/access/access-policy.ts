/**
 * Authoritative account/session gates.
 * Better Auth owns sessions; these helpers compare live account and session revisions before access or durable admission.
 * Callers acquire queue locks before account locks.
 * Background operations without an HTTP context must supply their account identity explicitly.
 */
import { and, eq, gt } from "drizzle-orm";
import type { db } from "@wrenly/db";
import { user, session } from "../../../../../../packages/db/src/schema";
import { accessContext } from "./access-context";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class AccessDeniedError extends Error {
  constructor() {
    super(
      "Your access has changed. Sign in again or contact the instance owner.",
    );
    this.name = "AccessDeniedError";
  }
}
/** Reads current status and a live revision-bound session; no cookie-cache authority. */
export async function readActivePrincipal(
  database: typeof db | Transaction,
  userId: string,
  sessionId: string,
): Promise<{ userId: string; sessionId: string; revision: string } | null> {
  const [row] = await database
    .select({ revision: user.accessRevision })
    .from(user)
    .innerJoin(
      session,
      and(
        eq(session.userId, user.id),
        eq(session.accessRevision, user.accessRevision),
      ),
    )
    .where(
      and(
        eq(user.id, userId),
        eq(user.banned, false),
        eq(session.id, sessionId),
        gt(session.expiresAt, new Date()),
      ),
    );
  return row ? { userId, sessionId, revision: row.revision } : null;
}
/** Locks the account after queue acquisition; stale HTTP principals cannot admit work after restoration. */
export async function assertActiveAccount(
  transaction: Transaction,
  userId: string,
): Promise<void> {
  const [account] = await transaction
    .select({ revision: user.accessRevision, banned: user.banned })
    .from(user)
    .where(eq(user.id, userId))
    .for("share");
  const principal = accessContext.getStore()?.principal;
  if (
    !account ||
    account.banned ||
    (principal && principal.userId !== userId) ||
    (principal?.userId === userId &&
      (principal.revision !== account.revision ||
        !(await readActivePrincipal(transaction, userId, principal.sessionId))))
  )
    throw new AccessDeniedError();
}
/** Native Better Auth owns session creation; the additional revision field is server-only. */
export function accessSessionHooks(database: typeof db | Transaction): {
  create: {
    before: (value: {
      userId: string;
    }) => Promise<{ data: { userId: string; accessRevision: string } }>;
  };
} {
  return {
    create: {
      before: async (value) => {
        const [account] = await database
          .select({ revision: user.accessRevision, banned: user.banned })
          .from(user)
          .where(eq(user.id, value.userId));
        if (!account || account.banned) throw new AccessDeniedError();
        return { data: { ...value, accessRevision: account.revision } };
      },
    },
  };
}
export const ACCESS_USER_FIELDS = {
  accessRevision: {
    type: "string" as const,
    input: false as const,
    returned: false as const,
    required: false as const,
    defaultValue: () => crypto.randomUUID(),
  },
};
export const ACCESS_SESSION_FIELDS = {
  accessRevision: {
    type: "string" as const,
    input: false as const,
    returned: false as const,
    required: false as const,
  },
};
