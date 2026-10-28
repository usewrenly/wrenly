import { databasePreviewIsReady } from "../../databases/bindings/preview-readiness";
import {
  readProjectCapabilities,
  readableProjectPredicate,
} from "../../projects/access/project-access";
import { assertActiveAccount } from "../../auth/access/access-policy";
// Preview grants remain bound to a live, revision-matching Better Auth session.
// Missing historical session bindings fail closed; reopening from Wrenly issues a new grant.
import { createHash, randomBytes } from "crypto";
import { and, eq, gt, isNull, desc } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  builds,
  projects,
  previews,
  previewAccess,
  session,
  user,
} from "../../../../../../packages/db/src/schema";
import { logger } from "../../../lib/logger";
import { PreviewStoreError } from "../persistence/preview-store";

const GRANT_MS = 60_000;
const SESSION_MS = 60 * 60 * 1000;
const MAX_ACCESS_ROWS = 32;
export function previewTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function previewOrigin(base: string, id: string): string {
  const url = new URL(base);
  url.hostname = `${id}.${url.hostname}`;
  return url.origin;
}
function usable(
  row: typeof previews.$inferSelect | undefined,
): row is typeof previews.$inferSelect {
  const now = Date.now();
  return Boolean(
    row &&
    row.status === "ready" &&
    row.leaseExpiresAt &&
    row.leaseExpiresAt.getTime() > now &&
    row.expiresAt &&
    row.expiresAt.getTime() > now,
  );
}
type AccessDatabase = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
async function authValid(
  database: AccessDatabase,
  userId: string,
  authSessionId: string | null,
): Promise<boolean> {
  if (!authSessionId) return false;
  const [active] = await database
    .select({ id: session.id })
    .from(session)
    .innerJoin(
      user,
      and(
        eq(user.id, session.userId),
        eq(user.accessRevision, session.accessRevision),
        eq(user.banned, false),
      ),
    )
    .where(
      and(
        eq(session.id, authSessionId),
        eq(session.userId, userId),
        gt(session.expiresAt, new Date()),
      ),
    );
  return Boolean(active);
}
/** Checks current project read access and control session before issuing a bounded, hashed grant. */
export async function issuePreviewGrant(
  database: typeof db,
  previewId: string,
  userId: string,
  authSessionId: string | null,
): Promise<string> {
  try {
    return database.transaction(async (transaction) => {
      await assertActiveAccount(transaction, userId);
      if (!(await authValid(transaction, userId, authSessionId)))
        throw new PreviewStoreError(401, "Sign in again.");
      const [row] = await transaction
        .select()
        .from(previews)
        .where(eq(previews.id, previewId))
        .for("update");
      if (
        !row ||
        !(await readProjectCapabilities(transaction, row.projectId, userId))
      )
        throw new PreviewStoreError(404, "Preview not found.");
      const [project] = await transaction
        .select({ revision: projects.accessRevision })
        .from(projects)
        .where(eq(projects.id, row.projectId));
      if (!project) throw new PreviewStoreError(404, "Preview not found.");
      if (!usable(row) || !(await databasePreviewIsReady(transaction, row)))
        throw new PreviewStoreError(
          409,
          "Preview is not ready or has expired.",
        );
      const prior = await transaction
        .select({ id: previewAccess.id })
        .from(previewAccess)
        .where(eq(previewAccess.previewId, previewId))
        .orderBy(desc(previewAccess.grantExpiresAt));
      // Old grants/sessions are explicitly revoked; no unbounded bootstrap history.
      for (const old of prior.slice(MAX_ACCESS_ROWS - 1))
        await transaction
          .delete(previewAccess)
          .where(eq(previewAccess.id, old.id));
      const token = randomBytes(32).toString("hex");
      await transaction
        .insert(previewAccess)
        .values({
          previewId,
          userId,
          projectRevision: project.revision,
          authSessionId,
          grantHash: previewTokenHash(token),
          grantExpiresAt: new Date(Date.now() + GRANT_MS),
        });
      return token;
    });
  } catch (error) {
    if (!(error instanceof PreviewStoreError))
      logger.error("Preview access persistence failed", {
        operation: "issuePreviewGrant",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    throw error;
  }
}
/** Single use is serialized by the grant row lock; a replay cannot mint a second session. */
export async function consumePreviewGrant(
  database: typeof db,
  previewId: string,
  token: string,
): Promise<string | null> {
  try {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    return database.transaction(async (transaction) => {
      const [grant] = await transaction
        .select()
        .from(previewAccess)
        .where(
          and(
            eq(previewAccess.previewId, previewId),
            eq(previewAccess.grantHash, previewTokenHash(token)),
          ),
        )
        .for("update");
      if (
        !grant ||
        !grant.authSessionId ||
        grant.consumedAt ||
        grant.grantExpiresAt.getTime() <= Date.now()
      )
        return null;
      const [row] = await transaction
        .select()
        .from(previews)
        .where(eq(previews.id, previewId));
      if (
        !usable(row) ||
        !(await databasePreviewIsReady(transaction, row)) ||
        !(await currentProjectAccess(
          transaction,
          row.projectId,
          grant.userId,
          grant.projectRevision,
        )) ||
        !(await authValid(transaction, grant.userId, grant.authSessionId))
      )
        return null;
      const sessionToken = randomBytes(32).toString("hex");
      await transaction
        .update(previewAccess)
        .set({
          consumedAt: new Date(),
          sessionHash: previewTokenHash(sessionToken),
          sessionExpiresAt: new Date(Date.now() + SESSION_MS),
        })
        .where(eq(previewAccess.id, grant.id));
      return sessionToken;
    });
  } catch (error) {
    if (!(error instanceof PreviewStoreError))
      logger.error("Preview access persistence failed", {
        operation: "consumePreviewGrant",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    throw error;
  }
}
/** Every gateway request rechecks ready state, lease, inactivity and the original control session. */
export async function authorizePreviewSession(
  database: typeof db,
  previewId: string,
  token: string,
): Promise<string | null> {
  try {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const [grant] = await database
      .select()
      .from(previewAccess)
      .where(
        and(
          eq(previewAccess.previewId, previewId),
          eq(previewAccess.sessionHash, previewTokenHash(token)),
          gt(previewAccess.sessionExpiresAt, new Date()),
        ),
      );
    if (!grant || !grant.authSessionId) return null;
    const [row] = await database
      .select()
      .from(previews)
      .where(eq(previews.id, previewId));
    if (
      !usable(row) ||
      !(await databasePreviewIsReady(database, row)) ||
      !(await currentProjectAccess(
        database,
        row.projectId,
        grant.userId,
        grant.projectRevision,
      )) ||
      !(await authValid(database, grant.userId, grant.authSessionId))
    )
      return null;
    return grant.userId;
  } catch (error) {
    if (!(error instanceof PreviewStoreError))
      logger.error("Preview access persistence failed", {
        operation: "authorizePreviewSession",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    throw error;
  }
}
/** Read-only build lookup avoids admitting work merely because a browser reloads. */
export async function getBuildPreview(
  database: typeof db,
  buildId: string,
  userId: string,
): Promise<{ id: string | null; activeId: string | null; supported: boolean }> {
  try {
    const [owned] = await database
      .select({
        projectId: builds.projectId,
        stack: builds.stack,
        projectStack: projects.stack,
      })
      .from(builds)
      .innerJoin(projects, eq(projects.id, builds.projectId))
      .where(
        and(eq(builds.id, buildId), readableProjectPredicate(database, userId)),
      );
    if (!owned) throw new PreviewStoreError(404, "Build not found.");
    const [latest] = await database
      .select({ id: previews.id })
      .from(previews)
      .where(and(eq(previews.buildId, buildId)))
      .orderBy(desc(previews.createdAt))
      .limit(1);
    const [active] = await database
      .select({ id: previews.id })
      .from(previews)
      .where(
        and(
          eq(previews.projectId, owned.projectId),
          isNull(previews.cleanupCompletedAt),
        ),
      )
      .limit(1);
    return {
      id: latest?.id ?? null,
      activeId: active?.id ?? null,
      supported: ["nextjs", "laravel"].includes(owned.stack ?? owned.projectStack),
    };
  } catch (error) {
    if (!(error instanceof PreviewStoreError))
      logger.error("Preview access persistence failed", {
        operation: "getBuildPreview",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    throw error;
  }
}

async function currentProjectAccess(
  database: Parameters<typeof readProjectCapabilities>[0],
  projectId: string,
  actorId: string,
  revision: string,
): Promise<boolean> {
  try {
    const [project] = await database
      .select({ revision: projects.accessRevision })
      .from(projects)
      .where(eq(projects.id, projectId));
    return Boolean(
      project &&
      project.revision === revision &&
      (await readProjectCapabilities(database, projectId, actorId)),
    );
  } catch {
    return false;
  }
}
