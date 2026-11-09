/**
 * COMPONENT: Saved GitHub authorization round-trip
 * PURPOSE: Consume each expiring callback once for the local session that started it.
 * INPUTS: Verified principal, configured origin, purpose and unpredictable callback state.
 * OUTPUTS: A saved authorization request or its one-time server-side claim.
 * STEPS: Lock account, recheck live session, enforce owner/App identity, persist hash and encrypted PKCE.
 * EDGE CASES: Revoked sessions, concurrent callbacks, stale App registration and expired state.
 * ERROR STATES: Reject before contacting GitHub; never retry an already-consumed exchange automatically.
 */
import { and, count, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  sourceAuthorizationRequests,
  sourceConnections,
  sourceGitHubApp,
  instanceSetup,
  type db,
} from "@wrenly/db";
import {
  AccessDeniedError,
  assertActiveAccount,
  readActivePrincipal,
} from "../../auth/access/access-policy";
import type { AccessPrincipal } from "../../auth/access/access-context";
import { logger } from "../../../lib/logger";
import {
  newSourceAuthorization,
  sourceCallbackUrl,
  sourceStateHash,
  SOURCE_AUTH_TTL_MS,
  type SourceAuthorizationPurpose,
} from "./authorization";
import {
  loadSourceCredentialKey,
  encryptSourceCredential,
  decryptSourceCredential,
} from "./credentials";
const MAX_PENDING_REQUESTS = 8;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class SourceConnectionError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "SourceConnectionError";
  }
}
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SourceConnectionError) throw error;
    if (error instanceof AccessDeniedError)
      throw new SourceConnectionError(
        403,
        "Your access changed. Sign in again before connecting GitHub.",
      );
    logger.error("Source authorization storage failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new SourceConnectionError(
      503,
      "Source connection storage is unavailable. Check migrations and the instance credential backup.",
    );
  }
}
/** Account locks serialize start/finish/disconnect with access changes; a live session is always required. */
export async function assertSourcePrincipal(
  tx: Transaction,
  principal: AccessPrincipal,
): Promise<void> {
  await assertActiveAccount(tx, principal.userId);
  const active = await readActivePrincipal(
    tx,
    principal.userId,
    principal.sessionId,
  );
  if (!active || active.revision !== principal.revision)
    throw new SourceConnectionError(
      403,
      "Sign in again before connecting GitHub.",
    );
}
async function requireInstanceOwner(
  tx: Transaction,
  actorId: string,
): Promise<void> {
  const [setup] = await tx
    .select()
    .from(instanceSetup)
    .where(eq(instanceSetup.id, 1))
    .for("share");
  if (!setup?.ownerId || setup.ownerId !== actorId)
    throw new SourceConnectionError(
      403,
      "Only the instance owner can register this instance’s GitHub App.",
    );
}
/** Check every credential family before creating another envelope; a replaced key cannot mix old/new secrets. */
export async function sourceKeyForWrite(
  tx: Transaction,
  directory: string,
): Promise<Buffer> {
  const [app] = await tx.select().from(sourceGitHubApp).limit(1);
  const [connection] = await tx
    .select()
    .from(sourceConnections)
    .where(isNotNull(sourceConnections.credential))
    .limit(1);
  const [request] = await tx
    .select()
    .from(sourceAuthorizationRequests)
    .where(isNotNull(sourceAuthorizationRequests.credential))
    .limit(1);
  const key = await loadSourceCredentialKey(
    directory,
    Boolean(app || connection || request),
  );
  if (app)
    decryptSourceCredential(app.credential, key, {
      kind: "app",
      id: app.version,
      userId: app.configuredBy,
    });
  if (connection)
    decryptSourceCredential(connection.credential, key, {
      kind: "user",
      id: connection.version,
      userId: connection.userId,
    });
  if (request)
    decryptSourceCredential(request.credential, key, {
      kind: "authorization",
      id: request.id,
      userId: request.userId,
    });
  return key;
}
export interface SourceAuthorizationClaim {
  id: string;
  userId: string;
  sessionId: string;
  purpose: SourceAuthorizationPurpose;
  appVersion: string | null;
  callbackUrl: string;
  verifier: string | null;
}
/** This creates no GitHub side effect. Losing the response is safe: explicitly start a fresh request. */
export async function beginSourceAuthorization(
  database: typeof db,
  principal: AccessPrincipal,
  purpose: SourceAuthorizationPurpose,
  origin: string,
  directory: string,
): Promise<{
  id: string;
  state: string;
  challenge: string;
  callbackUrl: string;
  clientId: string | null;
}> {
  return guarded(() =>
    database.transaction(async (tx) => {
      if (!["register-app", "connect-account"].includes(purpose))
        throw new SourceConnectionError(
          400,
          "Choose a supported connection action.",
        );
      await assertSourcePrincipal(tx, principal);
      const [app] = await tx
        .select()
        .from(sourceGitHubApp)
        .where(eq(sourceGitHubApp.id, 1))
        .for("share");
      if (purpose === "register-app") {
        await requireInstanceOwner(tx, principal.userId);
        if (app)
          throw new SourceConnectionError(
            409,
            "This instance already has a GitHub App.",
          );
      } else if (!app)
        throw new SourceConnectionError(
          409,
          "The instance owner must register a GitHub App first.",
        );
      const [pending] = await tx
        .select({ total: count() })
        .from(sourceAuthorizationRequests)
        .where(
          and(
            eq(sourceAuthorizationRequests.userId, principal.userId),
            isNull(sourceAuthorizationRequests.consumedAt),
            gt(sourceAuthorizationRequests.expiresAt, new Date()),
          ),
        );
      if ((pending?.total ?? 0) >= MAX_PENDING_REQUESTS)
        throw new SourceConnectionError(
          409,
          "Too many pending connections. Finish an open connection or wait ten minutes.",
        );
      const id = crypto.randomUUID(),
        fresh = newSourceAuthorization(),
        callbackUrl = sourceCallbackUrl(origin, purpose);
      const credential =
        purpose === "connect-account"
          ? encryptSourceCredential(
              fresh.verifier,
              await sourceKeyForWrite(tx, directory),
              { kind: "authorization", id, userId: principal.userId },
            )
          : null;
      await tx.insert(sourceAuthorizationRequests).values({
        id,
        userId: principal.userId,
        sessionId: principal.sessionId,
        accountRevision: principal.revision,
        purpose,
        appVersion: app?.version ?? null,
        stateHash: fresh.stateHash,
        callbackUrl,
        credential,
        expiresAt: new Date(Date.now() + SOURCE_AUTH_TTL_MS),
      });
      return {
        id,
        state: fresh.state,
        challenge: fresh.challenge,
        callbackUrl,
        clientId: app?.clientId ?? null,
      };
    }),
  );
}
/** Consume before external code exchange. A lost exchange needs a new authorization, never callback replay. */
export async function consumeSourceAuthorization(
  database: typeof db,
  principal: AccessPrincipal,
  purpose: SourceAuthorizationPurpose,
  state: string,
  origin: string,
  directory: string,
): Promise<SourceAuthorizationClaim> {
  return guarded(() =>
    database.transaction(async (tx) => {
      await assertSourcePrincipal(tx, principal);
      if (purpose === "register-app")
        await requireInstanceOwner(tx, principal.userId);
      const [app] = await tx
        .select()
        .from(sourceGitHubApp)
        .where(eq(sourceGitHubApp.id, 1))
        .for("share");
      const [request] = await tx
        .update(sourceAuthorizationRequests)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(sourceAuthorizationRequests.stateHash, sourceStateHash(state)),
            eq(sourceAuthorizationRequests.userId, principal.userId),
            eq(sourceAuthorizationRequests.sessionId, principal.sessionId),
            eq(sourceAuthorizationRequests.accountRevision, principal.revision),
            eq(sourceAuthorizationRequests.purpose, purpose),
            eq(
              sourceAuthorizationRequests.callbackUrl,
              sourceCallbackUrl(origin, purpose),
            ),
            isNull(sourceAuthorizationRequests.consumedAt),
            gt(sourceAuthorizationRequests.expiresAt, new Date()),
          ),
        )
        .returning();
      if (
        !request ||
        (purpose === "register-app"
          ? Boolean(app)
          : !app || app.version !== request.appVersion)
      )
        throw new SourceConnectionError(
          409,
          "This GitHub connection expired, was already used or belongs to another session. Start again.",
        );
      const verifier =
        purpose === "connect-account"
          ? z.string().parse(
              decryptSourceCredential(
                request.credential,
                await sourceKeyForWrite(tx, directory),
                {
                  kind: "authorization",
                  id: request.id,
                  userId: principal.userId,
                },
              ),
            )
          : null;
      return {
        id: request.id,
        userId: principal.userId,
        sessionId: principal.sessionId,
        purpose,
        appVersion: request.appVersion,
        callbackUrl: request.callbackUrl,
        verifier,
      };
    }),
  );
}
