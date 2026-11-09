import type { SourceConnectionStatus } from "@wrenly/source-control";
/** GitHub App/personal connection persistence. Only safe metadata leaves this server module. */
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  sourceAuthorizationRequests,
  sourceConnections,
  sourceGitHubApp,
  instanceSetup,
  type db,
} from "@wrenly/db";
import type { AccessPrincipal } from "../../auth/access/access-context";
import {
  assertSourcePrincipal,
  SourceConnectionError,
  sourceKeyForWrite,
} from "./authorization-store";
import {
  decryptSourceCredential,
  encryptSourceCredential,
} from "./credentials";
import type { GitHubAppExchange, GitHubTokenExchange } from "./exchange";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const UserIdentity = z.object({
  id: z.number().int().positive().safe(),
  login: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
});
async function claimed(
  tx: Transaction,
  principal: AccessPrincipal,
  id: string,
  purpose: "register-app" | "connect-account",
) {
  await assertSourcePrincipal(tx, principal);
  const [request] = await tx
    .select()
    .from(sourceAuthorizationRequests)
    .where(
      and(
        eq(sourceAuthorizationRequests.id, id),
        eq(sourceAuthorizationRequests.userId, principal.userId),
        eq(sourceAuthorizationRequests.sessionId, principal.sessionId),
        eq(sourceAuthorizationRequests.accountRevision, principal.revision),
        eq(sourceAuthorizationRequests.purpose, purpose),
        isNotNull(sourceAuthorizationRequests.consumedAt),
        isNull(sourceAuthorizationRequests.completedAt),
        gt(sourceAuthorizationRequests.expiresAt, new Date()),
      ),
    )
    .for("update");
  if (!request)
    throw new SourceConnectionError(
      409,
      "GitHub authorization changed or expired. Start a new connection.",
    );
  return request;
}
/** First registration only. App replacement/rotation needs a separate explicit lifecycle. */
export async function saveSourceGitHubApp(
  database: typeof db,
  principal: AccessPrincipal,
  requestId: string,
  app: GitHubAppExchange,
  directory: string,
): Promise<void> {
  await database.transaction(async (tx) => {
    await claimed(tx, principal, requestId, "register-app");
    const [setup] = await tx
      .select()
      .from(instanceSetup)
      .where(eq(instanceSetup.id, 1))
      .for("share");
    if (setup?.ownerId !== principal.userId)
      throw new SourceConnectionError(
        403,
        "Only the instance owner can register a GitHub App.",
      );
    const [existing] = await tx
      .select()
      .from(sourceGitHubApp)
      .where(eq(sourceGitHubApp.id, 1));
    if (existing)
      throw new SourceConnectionError(
        409,
        "A GitHub App is already registered.",
      );
    const version = crypto.randomUUID(),
      key = await sourceKeyForWrite(tx, directory);
    const credential = encryptSourceCredential(
      { clientSecret: app.client_secret, privateKey: app.pem },
      key,
      { kind: "app", id: version, userId: principal.userId },
    );
    await tx.insert(sourceGitHubApp).values({
      id: 1,
      version,
      appId: String(app.id),
      slug: app.slug,
      clientId: app.client_id,
      credential,
      configuredBy: principal.userId,
    });
    await tx
      .update(sourceAuthorizationRequests)
      .set({ completedAt: new Date() })
      .where(eq(sourceAuthorizationRequests.id, requestId));
  });
}
/** Only a consumed personal authorization can read the instance client secret for its code exchange. */
export async function readSourceAppForExchange(
  database: typeof db,
  principal: AccessPrincipal,
  requestId: string,
  directory: string,
): Promise<{
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  verifier: string;
}> {
  return await database.transaction(async (tx) => {
    const request = await claimed(tx, principal, requestId, "connect-account");
    const [app] = await tx
      .select()
      .from(sourceGitHubApp)
      .where(eq(sourceGitHubApp.id, 1))
      .for("share");
    if (!app || app.version !== request.appVersion)
      throw new SourceConnectionError(
        409,
        "The GitHub App changed. Connect again.",
      );
    const key = await sourceKeyForWrite(tx, directory);
    const secret = z
      .object({ clientSecret: z.string(), privateKey: z.string() })
      .parse(
        decryptSourceCredential(app.credential, key, {
          kind: "app",
          id: app.version,
          userId: app.configuredBy,
        }),
      );
    const verifier = z.string().parse(
      decryptSourceCredential(request.credential, key, {
        kind: "authorization",
        id: request.id,
        userId: principal.userId,
      }),
    );
    return {
      clientId: app.clientId,
      clientSecret: secret.clientSecret,
      callbackUrl: request.callbackUrl,
      verifier,
    };
  });
}
/** The identity must be read from GitHub with the exchanged token; never accept a browser's claimed account. */
export async function saveSourcePersonalConnection(
  database: typeof db,
  principal: AccessPrincipal,
  requestId: string,
  tokens: GitHubTokenExchange,
  identity: unknown,
  directory: string,
): Promise<void> {
  const remote = UserIdentity.parse(identity);
  await database.transaction(async (tx) => {
    const request = await claimed(tx, principal, requestId, "connect-account");
    const [app] = await tx
      .select()
      .from(sourceGitHubApp)
      .where(eq(sourceGitHubApp.id, 1))
      .for("share");
    if (!app || app.version !== request.appVersion)
      throw new SourceConnectionError(
        409,
        "The GitHub App changed. Connect again.",
      );
    const [previous] = await tx
      .select()
      .from(sourceConnections)
      .where(
        and(
          eq(sourceConnections.userId, principal.userId),
          eq(sourceConnections.provider, "github"),
        ),
      )
      .for("update");
    if (
      previous &&
      !previous.disconnectedAt &&
      previous.remoteUserId !== String(remote.id)
    )
      throw new SourceConnectionError(
        409,
        "Disconnect the existing GitHub account before choosing another account.",
      );
    const version = crypto.randomUUID(),
      key = await sourceKeyForWrite(tx, directory);
    const credential = encryptSourceCredential(
      { accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
      key,
      { kind: "user", id: version, userId: principal.userId },
    );
    const values = {
      version,
      userId: principal.userId,
      provider: "github",
      appVersion: app.version,
      remoteUserId: String(remote.id),
      remoteLogin: remote.login,
      credential,
      accessExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      refreshExpiresAt: new Date(
        Date.now() + tokens.refresh_token_expires_in * 1000,
      ),
      disconnectedAt: null,
    };
    await tx
      .insert(sourceConnections)
      .values(values)
      .onConflictDoUpdate({
        target: [sourceConnections.userId, sourceConnections.provider],
        set: values,
      });
    await tx
      .update(sourceAuthorizationRequests)
      .set({ completedAt: new Date(), credential: null })
      .where(eq(sourceAuthorizationRequests.id, requestId));
  });
}
/** Projection for the current local account only. Credential envelopes never cross the HTTP boundary. */
export async function readSourceConnectionStatus(
  database: typeof db,
  principal: AccessPrincipal,
): Promise<SourceConnectionStatus> {
  return await database.transaction(async (tx) => {
    await assertSourcePrincipal(tx, principal);
    const [setup] = await tx
      .select()
      .from(instanceSetup)
      .where(eq(instanceSetup.id, 1));
    const [app] = await tx
      .select()
      .from(sourceGitHubApp)
      .where(eq(sourceGitHubApp.id, 1));
    const [connection] = await tx
      .select()
      .from(sourceConnections)
      .where(
        and(
          eq(sourceConnections.userId, principal.userId),
          eq(sourceConnections.provider, "github"),
          isNull(sourceConnections.disconnectedAt),
        ),
      );
    return {
      canRegister: setup?.ownerId === principal.userId,
      app: app ? { slug: app.slug } : null,
      connection: connection
        ? {
            id: connection.id,
            version: connection.version,
            login: connection.remoteLogin,
            needsAuthorization:
              !app ||
              app.version !== connection.appVersion ||
              connection.accessExpiresAt <= new Date(),
          }
        : null,
    };
  });
}
/** Local revocation is immediate; it does not claim to uninstall the App from GitHub. */
export async function disconnectSourceConnection(
  database: typeof db,
  principal: AccessPrincipal,
  version: string,
): Promise<void> {
  if (!z.string().uuid().safeParse(version).success)
    throw new SourceConnectionError(
      400,
      "Review the current connection before disconnecting.",
    );
  await database.transaction(async (tx) => {
    await assertSourcePrincipal(tx, principal);
    const rows = await tx
      .update(sourceConnections)
      .set({
        credential: null,
        disconnectedAt: new Date(),
        version: crypto.randomUUID(),
      })
      .where(
        and(
          eq(sourceConnections.userId, principal.userId),
          eq(sourceConnections.provider, "github"),
          eq(sourceConnections.version, version),
          isNull(sourceConnections.disconnectedAt),
        ),
      )
      .returning({ id: sourceConnections.id });
    if (rows.length !== 1)
      throw new SourceConnectionError(
        409,
        "The connection changed. Reload before disconnecting.",
      );
    // Pending callbacks cannot reconnect after a deliberate disconnect.
    await tx
      .update(sourceAuthorizationRequests)
      .set({
        consumedAt: new Date(),
        completedAt: new Date(),
        credential: null,
      })
      .where(
        and(
          eq(sourceAuthorizationRequests.userId, principal.userId),
          eq(sourceAuthorizationRequests.purpose, "connect-account"),
          isNull(sourceAuthorizationRequests.completedAt),
        ),
      );
  });
}
/** Resolve only the current user's unexpired connection. Expired credentials require a fresh browser authorization. */
export async function readSourcePersonalToken(
  database: typeof db,
  principal: AccessPrincipal,
  directory: string,
): Promise<{ token: string; appId: string; version: string }> {
  return await database.transaction(async (tx) => {
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
      .for("share");
    if (
      !app ||
      !connection ||
      connection.appVersion !== app.version ||
      !connection.credential ||
      connection.accessExpiresAt <= new Date()
    )
      throw new SourceConnectionError(
        409,
        "Authorize your GitHub account again before reading repositories.",
      );
    const secret = z
      .object({ accessToken: z.string(), refreshToken: z.string() })
      .parse(
        decryptSourceCredential(
          connection.credential,
          await sourceKeyForWrite(tx, directory),
          { kind: "user", id: connection.version, userId: principal.userId },
        ),
      );
    return {
      token: secret.accessToken,
      appId: app.appId,
      version: connection.version,
    };
  });
}
