// Project owners pin exact immutable instruction versions; missing guidance never falls back to a personal default.
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  projects,
  skills,
  skillVersions,
  projectSkills,
  projectAccessActions,
  previewAccess,
  conversationTurns,
  conversations,
  buildJobs,
  builds,
  previews,
  deployments,
} from "@wrenly/db";
import {
  requireProjectCapability,
  ProjectAccessError,
} from "../projects/access/project-access";
import { AccessDeniedError } from "../auth/access/access-policy";
import { hasDatabaseWork } from "../databases/database-activity";
import { lockDatabaseQueues } from "../databases/database-store";
import { SkillError } from "./skill-contract";
import {
  parseSkillDocument,
  validateSkillSelection,
  SkillDocumentError,
} from "./skill-document";
import { logger } from "../../lib/logger";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const SelectionChange = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z.string().uuid(),
    versionIds: z
      .array(z.string().uuid())
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
import type { FrozenSkill } from "@wrenly/inference";
export type { FrozenSkill } from "@wrenly/inference";
export interface ProjectSkillState {
  revision: string;
  canManage: boolean;
  selected: Array<FrozenSkill & { archived: boolean }>;
  savedRevision?: string;
  replayed?: boolean;
}
async function selected(
  tx: Transaction,
  projectId: string,
): Promise<ProjectSkillState["selected"]> {
  const rows = await tx
    .select({
      version: skillVersions,
      archivedAt: skills.archivedAt,
      ownerId: skills.ownerId,
      projectOwnerId: projects.userId,
    })
    .from(projectSkills)
    .innerJoin(projects, eq(projects.id, projectSkills.projectId))
    .innerJoin(skillVersions, eq(skillVersions.id, projectSkills.versionId))
    .innerJoin(skills, eq(skills.id, skillVersions.skillId))
    .where(eq(projectSkills.projectId, projectId))
    .orderBy(asc(projectSkills.position))
    .limit(5)
    .for("share", { of: skills });
  if (
    rows.length > 4 ||
    new Set(rows.map((row) => row.version.skillId)).size !== rows.length ||
    rows.some((row) => row.ownerId !== row.projectOwnerId)
  )
    throw new SkillError(
      409,
      "The project skill selection needs owner review. No guidance was substituted.",
    );
  return rows.map(({ version, archivedAt }) => ({
    skillId: version.skillId,
    versionId: version.id,
    name: version.name,
    description: version.description,
    document: version.document,
    sha256: version.sha256,
    source: version.source,
    sourceUrl: version.sourceUrl,
    versionLabel: version.versionLabel,
    licenseNotes: version.licenseNotes,
    archived: archivedAt !== null,
  }));
}
async function state(
  tx: Transaction,
  projectId: string,
  actorId: string,
): Promise<ProjectSkillState> {
  const access = await requireProjectCapability(tx, projectId, actorId, "read");
  const [project] = await tx
    .select({ revision: projects.accessRevision })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new ProjectAccessError(404, "Project not found.");
  return {
    revision: project.revision,
    canManage: access.manage,
    selected: await selected(tx, projectId),
  };
}
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof SkillError ||
      error instanceof ProjectAccessError ||
      error instanceof AccessDeniedError
    )
      throw error;
    if (error instanceof SkillDocumentError)
      throw new SkillError(400, error.message);
    logger.error("Project skill operation could not be confirmed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new SkillError(
      503,
      "Project skills could not be confirmed. Keep the saved change identifier and check before retrying.",
    );
  }
}
/** Project readers can inspect intentionally shared guidance; they do not gain library access. */
export async function readProjectSkills(
  database: typeof db,
  projectId: string,
  actorId: string,
): Promise<ProjectSkillState> {
  return operation(() =>
    database.transaction((tx) => state(tx, projectId, actorId)),
  );
}
async function requireIdle(tx: Transaction, projectId: string): Promise<void> {
  const [turn] = await tx
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationTurns.conversationId),
    )
    .where(
      and(
        eq(conversations.projectId, projectId),
        or(
          inArray(conversationTurns.status, [
            "queued",
            "running",
            "waiting_build",
          ]),
          and(
            eq(conversationTurns.status, "interrupted"),
            isNull(conversationTurns.completedAt),
          ),
        ),
      ),
    )
    .limit(1);
  const [job] = await tx
    .select({ id: buildJobs.buildId })
    .from(buildJobs)
    .where(
      and(
        eq(buildJobs.projectId, projectId),
        or(
          inArray(buildJobs.status, ["queued", "running"]),
          and(
            eq(buildJobs.status, "interrupted"),
            isNull(buildJobs.completedAt),
          ),
        ),
      ),
    )
    .limit(1);
  const [legacy] = await tx
    .select({ id: builds.id })
    .from(builds)
    .where(
      and(
        eq(builds.projectId, projectId),
        inArray(builds.status, ["pending", "generating", "building"]),
      ),
    )
    .limit(1);
  const [preview] = await tx
    .select({ id: previews.id })
    .from(previews)
    .where(
      and(
        eq(previews.projectId, projectId),
        inArray(previews.status, ["queued", "preparing", "starting"]),
      ),
    )
    .limit(1);
  const [publishing] = await tx
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.projectId, projectId),
        or(
          inArray(deployments.status, [
            "queued",
            "preparing",
            "deploying",
            "verifying",
            "interrupted",
          ]),
          isNotNull(deployments.mutationIntent),
        ),
      ),
    )
    .limit(1);
  if (
    turn ||
    job ||
    legacy ||
    preview ||
    publishing ||
    (await hasDatabaseWork(tx, projectId))
  )
    throw new SkillError(
      409,
      "Finish or reconcile active project work before changing its skills.",
    );
}
/** Validate exact personal versions before pinning them to a newly created project.
 * The caller owns the account lock and project-creation transaction; failure rolls back both.
 */
export async function pinInitialProjectSkills(
  tx: Transaction,
  projectId: string,
  actorId: string,
  versionIds: string[],
): Promise<void> {
  await validateOwnedVersions(tx, actorId, versionIds);
  if (versionIds.length)
    await tx
      .insert(projectSkills)
      .values(
        versionIds.map((versionId, position) => ({
          projectId,
          versionId,
          position,
        })),
      );
}
async function validateOwnedVersions(
  tx: Transaction,
  actorId: string,
  versionIds: string[],
): Promise<void> {
  const versions = versionIds.length
    ? await tx
        .select({ version: skillVersions, skill: skills })
        .from(skillVersions)
        .innerJoin(skills, eq(skills.id, skillVersions.skillId))
        .where(inArray(skillVersions.id, versionIds))
        .orderBy(skills.id)
        .for("share", { of: skills })
    : [];
  if (
    versions.length !== versionIds.length ||
    versions.some(
      (row) => row.skill.ownerId !== actorId || row.skill.archivedAt,
    )
  )
    throw new SkillError(
      400,
      "Choose available versions from your own skill library. No substitute was selected.",
    );
  if (new Set(versions.map((row) => row.skill.id)).size !== versions.length)
    throw new SkillError(400, "Select only one version of each skill.");
  const documents = versions.map((row) =>
    parseSkillDocument(row.version.document),
  );
  validateSkillSelection(documents);
  if (
    versions.some(
      (row, index) => row.version.sha256 !== documents[index]?.sha256,
    )
  )
    throw new SkillError(
      409,
      "A stored skill failed verification. Review it before use.",
    );
}

/** Writes reuse the project CAS/audit boundary and global queue → account → project lock order. */
export async function changeProjectSkills(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
): Promise<ProjectSkillState> {
  const parsed = SelectionChange.safeParse(body);
  if (!parsed.success)
    throw new SkillError(
      400,
      "Select at most four different skill versions and a valid saved project revision.",
    );
  const input = parsed.data;
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        "project-skills-v1",
        input.expectedRevision,
        input.versionIds,
      ]),
    )
    .digest("hex");
  return operation(() =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProjectCapability(tx, projectId, actorId, "manage");
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) throw new ProjectAccessError(404, "Project not found.");
      const [prior] = await tx
        .select()
        .from(projectAccessActions)
        .where(
          and(
            eq(projectAccessActions.projectId, projectId),
            eq(projectAccessActions.actorId, actorId),
            eq(projectAccessActions.requestId, input.requestId),
          ),
        );
      if (prior) {
        if (prior.requestIdentity !== identity)
          throw new SkillError(
            409,
            "This change identifier was used for different project settings.",
          );
        return {
          ...(await state(tx, projectId, actorId)),
          savedRevision: prior.revision,
          replayed: true,
        };
      }
      if (project.accessRevision !== input.expectedRevision)
        throw new SkillError(
          409,
          "Project settings changed. Reload and compare the selection before saving.",
        );
      await requireIdle(tx, projectId);
      await validateOwnedVersions(tx, actorId, input.versionIds);
      await tx
        .delete(projectSkills)
        .where(eq(projectSkills.projectId, projectId));
      if (input.versionIds.length)
        await tx.insert(projectSkills).values(
          input.versionIds.map((versionId, position) => ({
            projectId,
            versionId,
            position,
          })),
        );
      const revision = crypto.randomUUID();
      await tx
        .update(projects)
        .set({ accessRevision: revision })
        .where(eq(projects.id, projectId));
      await tx
        .delete(previewAccess)
        .where(
          inArray(
            previewAccess.previewId,
            tx
              .select({ id: previews.id })
              .from(previews)
              .where(eq(previews.projectId, projectId)),
          ),
        );
      await tx.insert(projectAccessActions).values({
        projectId,
        actorId,
        requestId: input.requestId,
        requestIdentity: identity,
        previousRevision: project.accessRevision,
        revision,
      });
      return {
        ...(await state(tx, projectId, actorId)),
        savedRevision: revision,
        replayed: false,
      };
    }),
  );
}

/** Admission must call under its project lock; snapshots never reread the user's current version on retry. */
export async function freezeProjectSkills(
  tx: Transaction,
  projectId: string,
): Promise<FrozenSkill[]> {
  const rows = await selected(tx, projectId);
  if (rows.some((row) => row.archived))
    throw new SkillError(
      409,
      "A selected skill was archived. Ask the project owner to review the selection before starting inference.",
    );
  const documents = rows.map((row) => parseSkillDocument(row.document));
  validateSkillSelection(documents);
  if (rows.some((row, index) => row.sha256 !== documents[index]?.sha256))
    throw new SkillError(
      409,
      "Selected skill content could not be verified. No inference started.",
    );
  return rows.map(({ archived: _archived, ...snapshot }) => snapshot);
}
