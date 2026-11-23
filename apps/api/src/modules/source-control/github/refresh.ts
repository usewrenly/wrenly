/**
 * COMPONENT: Personal GitHub token refresh
 * PURPOSE: Rotate expiring credentials without replaying a single-use refresh token.
 * INPUTS: Current principal, encrypted connection and instance App credentials.
 * OUTPUTS: Refreshed encrypted credentials or an explicit browser reconnection requirement.
 * STEPS: Lock account, fingerprint ciphertext, persist one-use intent; exchange once; recheck and save.
 * EDGE CASES: Concurrent callers, disconnect, session revocation and lost exchange replies.
 * ERROR STATES: An unfinished intent permanently fences that old token; reconnect instead of replaying it.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  sourceConnections,
  sourceGitHubApp,
  sourceAuthorizationRequests,
  type db,
} from "@wrenly/db";
import type { AccessPrincipal } from "../../auth/access/access-context";
import {
  assertSourcePrincipal,
  SourceConnectionError,
  sourceKeyForWrite,
} from "./authorization-store";
import {
  encryptSourceCredential,
  decryptSourceCredential,
} from "./credentials";
import { exchangeGitHubRefresh, type GitHubTokenExchange } from "./exchange";
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const REFRESH_INTENT_TTL_MS = 10 * 60 * 1000;
function fingerprint(credential: unknown): string {
  return `refresh:${createHash("sha256").update(JSON.stringify(credential)).digest("hex")}`;
}
/** Constructing an intent commits before contacting GitHub, so an unknown reply cannot cause a second exchange. */
export async function refreshSourceAccessIfNeeded(
  database: typeof db,
  principal: AccessPrincipal,
  directory: string,
  exchange: (input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }) => Promise<GitHubTokenExchange> = exchangeGitHubRefresh,
): Promise<void> {
  const intent = await database.transaction(async (tx) => {
    await assertSourcePrincipal(tx, principal);
    const [app] = await tx
      .select()
      .from(sourceGitHubApp)
      .where(eq(sourceGitHubApp.id, 1))
      .for("share");
    const [connection] = await tx
      .select()
      .from(sourceConnections)
      .where(
        and(
          eq(sourceConnections.userId, principal.userId),
          eq(sourceConnections.provider, "github"),
          isNull(sourceConnections.disconnectedAt),
        ),
      )
      .for("update");
    if (
      !app ||
      !connection ||
      !connection.credential ||
      connection.appVersion !== app.version
    )
      throw new SourceConnectionError(
        409,
        "Authorize your GitHub account again.",
      );
    const hash = fingerprint(connection.credential);
    const [previous] = await tx
      .select({ id: sourceAuthorizationRequests.id })
      .from(sourceAuthorizationRequests)
      .where(eq(sourceAuthorizationRequests.stateHash, hash));
    if (previous)
      throw new SourceConnectionError(
        409,
        "An earlier token refresh could not be confirmed. Reconnect GitHub; the old refresh token will not be reused.",
      );
    if (connection.accessExpiresAt.getTime() > Date.now() + REFRESH_MARGIN_MS)
      return null;
    if (connection.refreshExpiresAt.getTime() <= Date.now())
      throw new SourceConnectionError(
        409,
        "GitHub authorization expired. Reconnect your account.",
      );
    const key = await sourceKeyForWrite(tx, directory);
    const secrets = z
      .object({ accessToken: z.string(), refreshToken: z.string() })
      .parse(
        decryptSourceCredential(connection.credential, key, {
          kind: "user",
          id: connection.version,
          userId: principal.userId,
        }),
      );
    const appSecret = z
      .object({ clientSecret: z.string(), privateKey: z.string() })
      .parse(
        decryptSourceCredential(app.credential, key, {
          kind: "app",
          id: app.version,
          userId: app.configuredBy,
        }),
      );
    const id = crypto.randomUUID();
    await tx
      .insert(sourceAuthorizationRequests)
      .values({
        id,
        userId: principal.userId,
        sessionId: principal.sessionId,
        accountRevision: principal.revision,
        stateHash: hash,
        purpose: "refresh-account",
        appVersion: app.version,
        callbackUrl: "server-token-refresh",
        consumedAt: new Date(),
        expiresAt: new Date(Date.now() + REFRESH_INTENT_TTL_MS),
      });
    return {
      id,
      hash,
      connectionId: connection.id,
      version: connection.version,
      appVersion: app.version,
      clientId: app.clientId,
      clientSecret: appSecret.clientSecret,
      refreshToken: secrets.refreshToken,
    };
  });
  if (!intent) return;
  try {
    const tokens = await exchange({
      clientId: intent.clientId,
      clientSecret: intent.clientSecret,
      refreshToken: intent.refreshToken,
    });
    await database.transaction(async (tx) => {
      await assertSourcePrincipal(tx, principal);
      const [connection] = await tx
        .select()
        .from(sourceConnections)
        .where(eq(sourceConnections.id, intent.connectionId))
        .for("update");
      const [app] = await tx
        .select()
        .from(sourceGitHubApp)
        .where(eq(sourceGitHubApp.id, 1))
        .for("share");
      if (
        !connection ||
        connection.disconnectedAt ||
        connection.version !== intent.version ||
        fingerprint(connection.credential) !== intent.hash ||
        app?.version !== intent.appVersion
      )
        throw new SourceConnectionError(
          409,
          "GitHub connection changed during refresh. Reconnect your account.",
        );
      const credential = encryptSourceCredential(
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
        },
        await sourceKeyForWrite(tx, directory),
        { kind: "user", id: connection.version, userId: principal.userId },
      );
      await tx
        .update(sourceConnections)
        .set({
          credential,
          accessExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          refreshExpiresAt: new Date(
            Date.now() + tokens.refresh_token_expires_in * 1000,
          ),
        })
        .where(eq(sourceConnections.id, connection.id));
      await tx
        .update(sourceAuthorizationRequests)
        .set({ completedAt: new Date() })
        .where(eq(sourceAuthorizationRequests.id, intent.id));
    });
  } catch {
    throw new SourceConnectionError(
      409,
      "GitHub refresh could not be confirmed. Reconnect your account before continuing.",
    );
  }
}
