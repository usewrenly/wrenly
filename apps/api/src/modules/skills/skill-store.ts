// Ordered account/library/Skill locks serialize versioned writes and reject stale saves.
import { createHash } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  skillLibraries,
  skills,
  skillVersions,
  skillActions,
} from "@wrenly/db";
import { assertActiveAccount } from "../auth/access/access-policy";
import { logger } from "../../lib/logger";
import {
  SkillCreate,
  SkillChange,
  SkillError,
  MAX_LIBRARY_SKILLS,
} from "./skill-contract";
import { parseSkillDocument, SkillDocumentError } from "./skill-document";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface SkillSaveResult {
  skillId: string;
  savedRevision: string;
  currentRevision: string;
  versionId: string;
  replayed: boolean;
}

async function lockLibrary(tx: Transaction, actorId: string): Promise<void> {
  await assertActiveAccount(tx, actorId);
  await tx
    .insert(skillLibraries)
    .values({ ownerId: actorId })
    .onConflictDoNothing();
  await tx
    .select()
    .from(skillLibraries)
    .where(eq(skillLibraries.ownerId, actorId))
    .for("update", { noWait: true });
}
function identity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function replay(
  tx: Transaction,
  actorId: string,
  requestId: string,
  skillId: string,
  expected: string,
): Promise<SkillSaveResult | null> {
  const [action] = await tx
    .select()
    .from(skillActions)
    .where(
      and(
        eq(skillActions.actorId, actorId),
        eq(skillActions.requestId, requestId),
      ),
    );
  if (!action) return null;
  if (action.skillId !== skillId || action.requestIdentity !== expected)
    throw new SkillError(
      409,
      "This save identifier was used for a different change. Review before saving again.",
    );
  const [current] = await tx
    .select()
    .from(skills)
    .where(and(eq(skills.id, skillId), eq(skills.ownerId, actorId)));
  if (!current) throw new SkillError(404, "Skill not found.");
  return {
    skillId,
    savedRevision: action.revision,
    currentRevision: current.revision,
    versionId: action.versionId,
    replayed: true,
  };
}
async function confirmedWrite(
  actorId: string,
  skillId: string,
  run: () => Promise<SkillSaveResult>,
): Promise<SkillSaveResult> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof SkillError ||
      (error instanceof Error && error.name === "AccessDeniedError")
    )
      throw error;
    if (error instanceof SkillDocumentError)
      throw new SkillError(400, error.message);
    logger.error("Skill save could not be confirmed", {
      actorId,
      skillId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new SkillError(
      503,
      "The save could not be confirmed. Keep your text and check this change before retrying.",
    );
  }
}
/** Personal library reads never expose another account's instructions, including to the instance owner. */
export async function listSkills(
  database: typeof db,
  actorId: string,
): Promise<unknown> {
  try {
    return await database.transaction(async (tx) => {
      await assertActiveAccount(tx, actorId);
      const rows = await tx
        .select({ skill: skills, version: skillVersions })
        .from(skills)
        .innerJoin(
          skillVersions,
          and(
            eq(skillVersions.id, skills.currentVersionId),
            eq(skillVersions.skillId, skills.id),
          ),
        )
        .where(eq(skills.ownerId, actorId))
        .orderBy(desc(skills.updatedAt), skills.id)
        .limit(MAX_LIBRARY_SKILLS);
      return { skills: rows };
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AccessDeniedError")
      throw error;
    logger.error("Skill library read failed", {
      actorId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new SkillError(503, "Your skills could not be loaded. Try again.");
  }
}
/** Every version preserves original text/provenance; replay compares the exact normalized request. */
export async function createSkill(
  database: typeof db,
  actorId: string,
  body: unknown,
): Promise<SkillSaveResult> {
  const parsed = SkillCreate.safeParse(body);
  if (!parsed.success)
    throw new SkillError(
      400,
      "Review the skill document and provenance before saving.",
    );
  const input = parsed.data;
  return confirmedWrite(actorId, input.skillId, () =>
    database.transaction(async (tx) => {
      await lockLibrary(tx, actorId);
      const key = identity(["create", input]);
      const prior = await replay(
        tx,
        actorId,
        input.requestId,
        input.skillId,
        key,
      );
      if (prior) return prior;
      const [existing] = await tx
        .select({ id: skills.id })
        .from(skills)
        .where(eq(skills.id, input.skillId));
      if (existing)
        throw new SkillError(
          409,
          "This skill identifier is already in use. Review your saved library.",
        );
      const [capacity] = await tx
        .select({ total: count() })
        .from(skills)
        .where(eq(skills.ownerId, actorId));
      if ((capacity?.total ?? 0) >= MAX_LIBRARY_SKILLS)
        throw new SkillError(
          409,
          "Your library supports at most 100 skills, including archived skills.",
        );
      const document = parseSkillDocument(input.document);
      const versionId = crypto.randomUUID(),
        revision = crypto.randomUUID();
      await tx.insert(skills).values({
        id: input.skillId,
        ownerId: actorId,
        revision,
        currentVersionId: versionId,
      });
      await tx.insert(skillVersions).values({
        id: versionId,
        skillId: input.skillId,
        authorId: actorId,
        document: document.document,
        sha256: document.sha256,
        name: document.name,
        description: document.description,
        source: input.source,
        sourceUrl: input.sourceUrl,
        versionLabel: input.versionLabel,
        licenseNotes: input.licenseNotes,
      });
      await tx.insert(skillActions).values({
        actorId,
        requestId: input.requestId,
        skillId: input.skillId,
        requestIdentity: key,
        revision,
        versionId,
      });
      return {
        skillId: input.skillId,
        savedRevision: revision,
        currentRevision: revision,
        versionId,
        replayed: false,
      };
    }),
  );
}
/** Content changes append versions; archive changes only future availability, never old content. */
export async function changeSkill(
  database: typeof db,
  actorId: string,
  skillId: string,
  body: unknown,
): Promise<SkillSaveResult> {
  const parsed = SkillChange.safeParse(body);
  if (!parsed.success)
    throw new SkillError(
      400,
      "Review the skill change and saved revision before saving.",
    );
  const input = parsed.data;
  return confirmedWrite(actorId, skillId, () =>
    database.transaction(async (tx) => {
      await lockLibrary(tx, actorId);
      const key = identity(["change", skillId, input]);
      const prior = await replay(tx, actorId, input.requestId, skillId, key);
      if (prior) return prior;
      const [current] = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.id, skillId), eq(skills.ownerId, actorId)))
        .for("update");
      if (!current) throw new SkillError(404, "Skill not found.");
      if (current.revision !== input.expectedRevision)
        throw new SkillError(
          409,
          "This skill changed. Keep your text, reload and compare before saving.",
        );
      let versionId = current.currentVersionId;
      if (input.kind === "content") {
        if (current.archivedAt)
          throw new SkillError(
            409,
            "Restore this skill before saving a new version.",
          );
        const document = parseSkillDocument(input.document);
        versionId = crypto.randomUUID();
        await tx.insert(skillVersions).values({
          id: versionId,
          skillId,
          authorId: actorId,
          document: document.document,
          sha256: document.sha256,
          name: document.name,
          description: document.description,
          source: input.source,
          sourceUrl: input.sourceUrl,
          versionLabel: input.versionLabel,
          licenseNotes: input.licenseNotes,
        });
      }
      const revision = crypto.randomUUID();
      await tx
        .update(skills)
        .set({
          revision,
          currentVersionId: versionId,
          updatedAt: new Date(),
          ...(input.kind === "archive"
            ? { archivedAt: input.archived ? new Date() : null }
            : {}),
        })
        .where(eq(skills.id, skillId));
      await tx.insert(skillActions).values({
        actorId,
        requestId: input.requestId,
        skillId,
        requestIdentity: key,
        revision,
        versionId,
      });
      return {
        skillId,
        savedRevision: revision,
        currentRevision: revision,
        versionId,
        replayed: false,
      };
    }),
  );
}

/** A frozen UUID can be reconciled without replaying a mutation or starting inference. */
export async function getSkillAction(
  database: typeof db,
  actorId: string,
  skillId: string,
  requestId: string,
): Promise<SkillSaveResult | null> {
  try {
    return await database.transaction(async (tx) => {
      await assertActiveAccount(tx, actorId);
      const [current] = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.id, skillId), eq(skills.ownerId, actorId)));
      if (!current) return null;
      const [action] = await tx
        .select()
        .from(skillActions)
        .where(
          and(
            eq(skillActions.actorId, actorId),
            eq(skillActions.skillId, skillId),
            eq(skillActions.requestId, requestId),
          ),
        );
      return action
        ? {
            skillId,
            savedRevision: action.revision,
            currentRevision: current.revision,
            versionId: action.versionId,
            replayed: true,
          }
        : null;
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AccessDeniedError")
      throw error;
    logger.error("Skill acknowledgement read failed", {
      actorId,
      skillId,
      requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new SkillError(
      503,
      "This save could not be checked. Keep the same change identifier and retry later.",
    );
  }
}

/** Returns bounded immutable history only to the library owner. */
export async function readSkill(
  database: typeof db,
  actorId: string,
  skillId: string,
): Promise<unknown> {
  try {
    return await database.transaction(async (tx) => {
      await assertActiveAccount(tx, actorId);
      const [skill] = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.id, skillId), eq(skills.ownerId, actorId)))
        .for("share");
      if (!skill) throw new SkillError(404, "Skill not found.");
      const versions = await tx
        .select()
        .from(skillVersions)
        .where(eq(skillVersions.skillId, skillId))
        .orderBy(desc(skillVersions.createdAt), skillVersions.id)
        .limit(50);
      return { skill, versions, historyLimit: 50 };
    });
  } catch (error) {
    if (
      error instanceof SkillError ||
      (error instanceof Error && error.name === "AccessDeniedError")
    )
      throw error;
    logger.error("Skill history read failed", {
      actorId,
      skillId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new SkillError(
      503,
      "This skill could not be loaded. Keep your text and retry later.",
    );
  }
}

/** Fail before workers/HTTP bind if an installation lacks immutable skill persistence. */
export async function verifySkillsSchema(database: typeof db): Promise<void> {
  try {
    await database.select().from(skillLibraries).limit(0);
    await database.select().from(skills).limit(0);
    await database.select().from(skillVersions).limit(0);
    await database.select().from(skillActions).limit(0);
    const { projectSkills, conversationTurns } = await import("@wrenly/db");
    await database.select().from(projectSkills).limit(0);
    await database
      .select({ skillsV1: conversationTurns.skillsV1 })
      .from(conversationTurns)
      .limit(0);
  } catch (error) {
    throw new Error(
      "Skills requires migrations through 0030. Run bun run db:migrate from packages/db before starting the API.",
      { cause: error },
    );
  }
}
