/**
 * Project sharing persistence.
 * Owner-only accepted-member grants use current capabilities, queue/account/project locks, audited request replay and access revisions.
 * Access reductions respect active work and revoke preview grants; no public links or instance-admin bypass.
 */
import { hasDatabaseWork } from "../../databases/database-activity";
import { and, eq, inArray, isNull, isNotNull, or, ilike } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  projects,
  projectMembers,
  projectModels,
  projectAccessActions,
  member,
  instanceSetup,
  user,
  providerConnections,
  conversationQueue,
  buildQueue,
  previewQueue,
  deploymentQueue,
  conversations,
  conversationTurns,
  builds,
  buildJobs,
  previews,
  previewAccess,
  deployments,
} from "@wrenly/db";
import {
  readProjectCapabilities,
  requireProjectCapability,
  ProjectAccessError,
} from "../access/project-access";
import { resolveInferenceSelection } from "../../models/selection/saved-providers";
const QUEUE_ID = 1;
const MAX_MEMBERS = 128;
export const SharingInput = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z.string().uuid(),
    mode: z.enum(["private", "selected", "instance"]),
    instanceRole: z.enum(["viewer", "editor"]),
    members: z
      .array(
        z
          .object({
            userId: z.string().min(1).max(128),
            role: z.enum(["viewer", "editor"]),
          })
          .strict(),
      )
      .max(MAX_MEMBERS),
  })
  .strict();
export class SharingError extends Error {
  constructor(
    public readonly status: 400 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "SharingError";
  }
}
/** A project owner can select accepted members; callers never receive invitation/admin secrets. */
export async function getProjectSharing(
  database: typeof db,
  projectId: string,
  actorId: string,
  search = "",
): Promise<unknown> {
  try {
    const permission = await readProjectCapabilities(
      database,
      projectId,
      actorId,
    );
    if (!permission) throw new ProjectAccessError(404, "Project not found.");
    const [project] = await database
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new ProjectAccessError(404, "Project not found.");
    const [binding] = await database
      .select({
        connectionId: projectModels.connectionId,
        modelId: projectModels.modelId,
        version: providerConnections.version,
        enabled: providerConnections.enabled,
      })
      .from(projectModels)
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, projectModels.connectionId),
      )
      .where(eq(projectModels.projectId, projectId));
    const common = {
      archivedAt: project.archivedAt,
      mode: project.accessMode,
      revision: project.accessRevision,
      instanceRole: project.instanceRole,
      capabilities: permission,
      model: binding ?? null,
    };
    if (!permission.manage) return common;
    const selected = await database
      .select({
        userId: projectMembers.userId,
        role: projectMembers.role,
        name: user.name,
        email: user.email,
        suspended: user.banned,
      })
      .from(projectMembers)
      .innerJoin(user, eq(user.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId));
    const eligible = await database
      .select({ userId: user.id, name: user.name, email: user.email })
      .from(member)
      .innerJoin(
        instanceSetup,
        and(
          eq(instanceSetup.id, 1),
          eq(instanceSetup.organizationId, member.organizationId),
        ),
      )
      .innerJoin(user, eq(user.id, member.userId))
      .where(
        and(
          eq(user.banned, false),
          isNotNull(instanceSetup.initializedAt),
          search
            ? or(
                ilike(user.name, `%${search.slice(0, 100)}%`),
                ilike(user.email, `%${search.slice(0, 100)}%`),
              )
            : undefined,
        ),
      )
      .orderBy(user.name, user.id)
      .limit(64);
    return {
      ...common,
      members: selected,
      eligible: eligible.filter((person) => person.userId !== actorId),
    };
  } catch (error) {
    if (error instanceof ProjectAccessError) throw error;
    throw new Error("Project sharing state could not be loaded.", {
      cause: error,
    });
  }
}
/** Changes are serialized with admission and cannot partially grant a reviewed member set. */
export async function changeProjectSharing(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
): Promise<{
  savedRevision: string;
  currentRevision: string;
  replayed: boolean;
}> {
  const parsed = SharingInput.safeParse(body);
  if (!parsed.success)
    throw new SharingError(
      400,
      "Review the project access mode and member roles.",
    );
  const input = parsed.data;
  if (input.mode !== "selected" && input.members.length)
    throw new SharingError(
      400,
      "Only selected-member sharing can contain individual grants.",
    );
  const identity = JSON.stringify([
    "sharing",
    input.expectedRevision,
    input.mode,
    input.instanceRole,
    [...input.members].sort((a, b) => a.userId.localeCompare(b.userId)),
  ]);
  try {
    return await database.transaction(async (tx) => {
      for (const table of [
        conversationQueue,
        buildQueue,
        previewQueue,
        deploymentQueue,
      ]) {
        await tx.insert(table).values({ id: QUEUE_ID }).onConflictDoNothing();
        await tx
          .select()
          .from(table)
          .where(eq(table.id, QUEUE_ID))
          .for("update", { noWait: true });
      }
      await requireProjectCapability(tx, projectId, actorId, "manage");
      if (
        new Set(input.members.map((value) => value.userId)).size !==
          input.members.length ||
        input.members.some((value) => value.userId === actorId)
      )
        throw new SharingError(
          400,
          "Choose each member once. The owner is protected.",
        );

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
          throw new SharingError(
            409,
            "This request identifier was used for another change.",
          );
        return {
          savedRevision: prior.revision,
          currentRevision: project.accessRevision,
          replayed: true,
        };
      }
      if (project.accessRevision !== input.expectedRevision)
        throw new SharingError(
          409,
          "Project access changed. Reload and review your selection.",
        );
      const oldGrants = await tx
        .select({ userId: projectMembers.userId, role: projectMembers.role })
        .from(projectMembers)
        .where(eq(projectMembers.projectId, projectId));
      const narrows = projectAccessNarrows(
        {
          mode: project.accessMode,
          instanceRole: project.instanceRole,
          members: oldGrants,
        },
        input,
      );
      if (narrows && (await hasDatabaseWork(tx, projectId)))
        throw new SharingError(
          409,
          "Finish or reconcile database work before changing project access.",
        );
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
            inArray(conversationTurns.status, [
              "queued",
              "running",
              "waiting_build",
            ]),
          ),
        )
        .limit(1);
      const [job] = await tx
        .select({ id: buildJobs.buildId })
        .from(buildJobs)
        .where(
          and(
            eq(buildJobs.projectId, projectId),
            inArray(buildJobs.status, ["queued", "running"]),
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
      const [preparing] = await tx
        .select({ id: previews.id })
        .from(previews)
        .where(
          and(
            eq(previews.projectId, projectId),
            or(
              inArray(previews.status, ["queued", "preparing", "starting"]),
              and(
                eq(previews.status, "interrupted"),
                isNull(previews.cleanupCompletedAt),
              ),
            ),
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
      if (narrows && (turn || job || legacy || preparing || publishing))
        throw new SharingError(
          409,
          "Wait for active project work or interrupted-operation recovery before changing access.",
        );
      for (const target of [...input.members].sort((a, b) =>
        a.userId.localeCompare(b.userId),
      )) {
        const [account] = await tx
          .select({ banned: user.banned })
          .from(user)
          .where(eq(user.id, target.userId))
          .for("share");
        const [accepted] = await tx
          .select({ id: member.id })
          .from(member)
          .innerJoin(
            instanceSetup,
            and(
              eq(instanceSetup.id, 1),
              eq(instanceSetup.organizationId, member.organizationId),
            ),
          )
          .where(
            and(
              eq(member.userId, target.userId),
              isNotNull(instanceSetup.initializedAt),
            ),
          );
        if (!account || account.banned || !accepted)
          throw new SharingError(
            400,
            "A selected person is not an active member of this instance. Review the member list.",
          );
      }
      if (
        (input.mode === "instance" && input.instanceRole === "editor") ||
        input.members.some((value) => value.role === "editor")
      ) {
        const [binding] = await tx
          .select()
          .from(projectModels)
          .where(eq(projectModels.projectId, projectId));
        if (!binding)
          throw new SharingError(
            400,
            "Choose the project model before granting Editor access.",
          );
        try {
          await resolveInferenceSelection(
            tx,
            binding.connectionId,
            binding.modelId,
          );
        } catch {
          throw new SharingError(
            400,
            "Review the project model connection before granting Editor access.",
          );
        }
      }
      await tx
        .delete(projectMembers)
        .where(eq(projectMembers.projectId, projectId));
      if (input.members.length)
        await tx
          .insert(projectMembers)
          .values(input.members.map((value) => ({ ...value, projectId })));
      const revision = crypto.randomUUID();
      await tx
        .update(projects)
        .set({
          accessMode: input.mode,
          instanceRole: input.instanceRole,
          accessRevision: revision,
        })
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
        savedRevision: revision,
        currentRevision: revision,
        replayed: false,
      };
    });
  } catch (error) {
    if (error instanceof SharingError || error instanceof ProjectAccessError)
      throw error;
    let cause: unknown = error;
    for (
      let depth = 0;
      depth < 6 && cause && typeof cause === "object";
      depth++
    ) {
      if ("code" in cause && ["55P03", "40P01"].includes(String(cause.code)))
        throw new SharingError(
          409,
          "Project access is busy. Wait, then review again.",
        );
      cause = "cause" in cause ? cause.cause : null;
    }
    throw error;
  }
}
/** Recorded success is distinct from the current policy, so stale acknowledgements are visible. */
export async function getProjectAccessAction(
  database: typeof db,
  projectId: string,
  actorId: string,
  requestId: string,
): Promise<unknown> {
  try {
    if (
      (await readProjectCapabilities(database, projectId, actorId))?.role !==
      "owner"
    )
      throw new ProjectAccessError(404, "Project not found.");
    const [row] = await database
      .select({ revision: projectAccessActions.revision })
      .from(projectAccessActions)
      .where(
        and(
          eq(projectAccessActions.projectId, projectId),
          eq(projectAccessActions.actorId, actorId),
          eq(projectAccessActions.requestId, requestId),
        ),
      );
    const [project] = await database
      .select({ revision: projects.accessRevision })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row
      ? { savedRevision: row.revision, currentRevision: project?.revision }
      : null;
  } catch (error) {
    if (error instanceof ProjectAccessError) throw error;
    throw new Error("Project sharing state could not be loaded.", {
      cause: error,
    });
  }
}

/** Everyone includes future accepted members, so switching it to a finite list narrows access. */
export function projectAccessNarrows(
  previous: Pick<
    z.infer<typeof SharingInput>,
    "mode" | "instanceRole" | "members"
  >,
  next: Pick<z.infer<typeof SharingInput>, "mode" | "instanceRole" | "members">,
): boolean {
  if (previous.mode === "private") return false;
  if (previous.mode === "instance")
    return (
      next.mode !== "instance" ||
      (previous.instanceRole === "editor" && next.instanceRole !== "editor")
    );
  return previous.members.some((old) => {
    const role =
      next.mode === "instance"
        ? next.instanceRole
        : next.mode === "selected"
          ? next.members.find((person) => person.userId === old.userId)?.role
          : undefined;
    return !role || (old.role === "editor" && role !== "editor");
  });
}
