/** Uses real grants and control sessions to exercise each database-preview gateway entry point. */
import { expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { db } from "@wrenly/db";
import { session, user, previews, previewDatabaseRuntime } from "../../src/schema";
import {
  issuePreviewGrant, consumePreviewGrant, authorizePreviewSession,
} from "../../../../apps/api/src/modules/previews/access/preview-access";

/** Viewer access stays read-only and cannot bypass missing runtime confirmations. */
export async function verifyDatabasePreviewAccess(
  database: typeof db,
  preview: typeof previews.$inferSelect,
): Promise<void> {
  const actorId = "db-viewer";
  const [actor] = await database.select().from(user).where(eq(user.id, actorId));
  const [runtime] = await database.select().from(previewDatabaseRuntime)
    .where(eq(previewDatabaseRuntime.previewId, preview.id));
  if (!actor || !runtime) throw new Error("Missing gateway fixture");
  const sessionId = crypto.randomUUID();
  await database.insert(session).values({ id: sessionId, userId: actorId,
    accessRevision: actor.accessRevision, token: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 60_000) });
  try {
    const grant = await issuePreviewGrant(database, preview.id, actorId, sessionId);
    const token = await consumePreviewGrant(database, preview.id, grant);
    if (!token) throw new Error("Expected database preview viewer session");
    expect(await authorizePreviewSession(database, preview.id, token)).toBe(actorId);
    const pending = await issuePreviewGrant(database, preview.id, actorId, sessionId);
    await database.update(previewDatabaseRuntime).set({ completedEffects: runtime.completedEffects.slice(0, 2) })
      .where(eq(previewDatabaseRuntime.previewId, preview.id));
    await expect(issuePreviewGrant(database, preview.id, actorId, sessionId)).rejects.toMatchObject({ status: 409 });
    expect(await consumePreviewGrant(database, preview.id, pending)).toBeNull();
    expect(await authorizePreviewSession(database, preview.id, token)).toBeNull();
    await database.update(previewDatabaseRuntime).set({ completedEffects: runtime.completedEffects })
      .where(eq(previewDatabaseRuntime.previewId, preview.id));
    expect(await authorizePreviewSession(database, preview.id, token)).toBe(actorId);
    await database.delete(session).where(eq(session.id, sessionId));
    expect(await authorizePreviewSession(database, preview.id, token)).toBeNull();
  } finally {
    await database.update(previewDatabaseRuntime).set({ completedEffects: runtime.completedEffects })
      .where(eq(previewDatabaseRuntime.previewId, preview.id));
    await database.delete(session).where(eq(session.id, sessionId));
  }
}
