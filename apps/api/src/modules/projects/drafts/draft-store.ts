/**
 * Collaborative draft persistence.
 * Queue/account/draft locking, accepted-member roles, CAS revisions and actor-scoped replay serialize content and sharing changes.
 * Archived drafts retain read history; explicit user Send is required to turn text into build work.
 */
import { logger } from "../../../lib/logger";
import { createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  ilike,
  isNotNull,
  or,
  type SQL,
} from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  projectDrafts,
  projectDraftMembers,
  projectDraftActions,
  member,
  instanceSetup,
  user,
} from "@wrenly/db";
import {
  AccessDeniedError,
  assertActiveAccount,
} from "../../auth/access/access-policy";
import { lockDatabaseQueues } from "../../databases/database-store";
import { DraftCreate, DraftChange, DraftError } from "./draft-contract";
import {
  resolveProjectCapabilities,
  type ProjectCapabilities,
} from "../access/project-access";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Draft = typeof projectDrafts.$inferSelect;
function membership(tx: Transaction, actorId: string | typeof user.id): SQL {
  return exists(
    tx
      .select({ id: member.id })
      .from(member)
      .innerJoin(
        instanceSetup,
        eq(instanceSetup.organizationId, member.organizationId),
      )
      .where(
        and(
          eq(instanceSetup.id, 1),
          isNotNull(instanceSetup.initializedAt),
          eq(member.userId, actorId),
        ),
      ),
  );
}
function readable(tx: Transaction, actorId: string): SQL {
  const selected = exists(
    tx
      .select({ id: projectDraftMembers.draftId })
      .from(projectDraftMembers)
      .where(
        and(
          eq(projectDraftMembers.draftId, projectDrafts.id),
          eq(projectDraftMembers.userId, actorId),
        ),
      ),
  );
  return or(
    eq(projectDrafts.ownerId, actorId),
    and(
      membership(tx, actorId),
      or(
        eq(projectDrafts.accessMode, "instance"),
        and(eq(projectDrafts.accessMode, "selected"), selected),
      ),
    ),
  )!;
}
async function authorized(
  tx: Transaction,
  id: string,
  actorId: string,
): Promise<{ draft: Draft; capabilities: ProjectCapabilities }> {
  await assertActiveAccount(tx, actorId);
  const [draft] = await tx
    .select()
    .from(projectDrafts)
    .where(and(eq(projectDrafts.id, id), readable(tx, actorId)))
    .for("update");
  if (!draft)
    throw new DraftError(404, "Draft not found or your access has changed.");
  const [grant] = await tx
    .select()
    .from(projectDraftMembers)
    .where(
      and(
        eq(projectDraftMembers.draftId, id),
        eq(projectDraftMembers.userId, actorId),
      ),
    );
  const capabilities = resolveProjectCapabilities({
    active: true,
    actorId,
    ownerId: draft.ownerId,
    mode: draft.accessMode,
    acceptedMember: true,
    selectedRole: grant?.role ?? null,
    instanceRole: draft.instanceRole,
  });
  if (!capabilities) throw new DraftError(404, "Draft not found.");
  return { draft, capabilities };
}
async function snapshot(
  tx: Transaction,
  id: string,
  actorId: string,
): Promise<unknown> {
  const { draft, capabilities } = await authorized(tx, id, actorId);
  const [author] = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, draft.updatedBy));
  const members = await tx
    .select({
      userId: projectDraftMembers.userId,
      role: projectDraftMembers.role,
      name: user.name,
    })
    .from(projectDraftMembers)
    .innerJoin(user, eq(user.id, projectDraftMembers.userId))
    .where(eq(projectDraftMembers.draftId, id));
  return {
    ...draft,
    capabilities,
    updatedByName: author?.name ?? "Member",
    members: capabilities.manage ? members : [],
  };
}
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DraftError || error instanceof AccessDeniedError)
      throw error;
    logger.error("Draft storage operation failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new DraftError(
      503,
      "Draft operation could not be confirmed. Keep your text and retry the same request.",
    );
  }
}
/** Lists bounded metadata only; private draft bodies never enter project collections. */
export async function listDrafts(
  database: typeof db,
  actorId: string,
  offset = 0,
): Promise<unknown> {
  return operation(() =>
    database.transaction(async (tx) => {
      await assertActiveAccount(tx, actorId);
      const rows = await tx
        .select({
          id: projectDrafts.id,
          title: projectDrafts.title,
          revision: projectDrafts.revision,
          accessMode: projectDrafts.accessMode,
          archivedAt: projectDrafts.archivedAt,
          updatedAt: projectDrafts.updatedAt,
          owned: eq(projectDrafts.ownerId, actorId),
        })
        .from(projectDrafts)
        .where(readable(tx, actorId))
        .orderBy(desc(projectDrafts.updatedAt), desc(projectDrafts.id))
        .limit(25)
        .offset(offset);
      return { drafts: rows.slice(0, 24), hasMore: rows.length > 24 };
    }),
  );
}
/** Returns only a currently authorized draft, including immutable saved revision for conflict review. */
export async function readDraft(
  database: typeof db,
  id: string,
  actorId: string,
): Promise<unknown> {
  return operation(() =>
    database.transaction((tx) => snapshot(tx, id, actorId)),
  );
}
/** Directory search is available only to a draft owner and contains accepted active members. */
export async function draftCandidates(
  database: typeof db,
  id: string,
  actorId: string,
  search = "",
): Promise<unknown> {
  return operation(() =>
    database.transaction(async (tx) => {
      const { capabilities } = await authorized(tx, id, actorId);
      if (!capabilities.manage)
        throw new DraftError(403, "Only the draft owner can manage sharing.");
      const rows = await tx
        .select({ userId: user.id, name: user.name })
        .from(user)
        .where(
          and(
            eq(user.banned, false),
            membership(tx, user.id),
            search
              ? ilike(user.name, `%${search.replace(/[\\%_]/g, "\\$&")}%`)
              : undefined,
          ),
        )
        .orderBy(user.name, user.id)
        .limit(100);
      return { members: rows.filter((row) => row.userId !== actorId) };
    }),
  );
}
/** Saves with actor-scoped replay, revision compare and current sharing authority; never starts inference. */
export async function mutateDraft(
  database: typeof db,
  actorId: string,
  body: unknown,
  id?: string,
): Promise<unknown> {
  const parsed = id ? DraftChange.safeParse(body) : DraftCreate.safeParse(body);
  if (!parsed.success)
    throw new DraftError(
      400,
      "Review the draft fields, sharing choices and current revision.",
    );
  const input = parsed.data;
  const draftId = id ?? ("draftId" in input ? input.draftId : "");
  const identity = createHash("sha256")
    .update(JSON.stringify([draftId, input]))
    .digest("hex");
  return operation(() =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await assertActiveAccount(tx, actorId);
      const [prior] = await tx
        .select()
        .from(projectDraftActions)
        .where(
          and(
            eq(projectDraftActions.actorId, actorId),
            eq(projectDraftActions.requestId, input.requestId),
          ),
        );
      if (prior) {
        if (prior.requestIdentity !== identity)
          throw new DraftError(
            409,
            "This request belongs to another draft change.",
          );
        const current = await snapshot(tx, draftId, actorId);
        return {
          draft: current,
          savedRevision: prior.revision,
          replayed: true,
        };
      }
      const revision = crypto.randomUUID();
      if ("draftId" in input) {
        const [accepted] = await tx
          .select({ id: user.id })
          .from(user)
          .where(and(eq(user.id, actorId), membership(tx, actorId)));
        if (!accepted)
          throw new DraftError(
            403,
            "Join this instance before creating a draft.",
          );
        const [created] = await tx
          .insert(projectDrafts)
          .values({
            id: draftId,
            ownerId: actorId,
            updatedBy: actorId,
            title: input.title,
            body: input.body,
            revision,
          })
          .onConflictDoNothing()
          .returning({ id: projectDrafts.id });
        if (!created)
          throw new DraftError(
            409,
            "This draft identity already exists. Reload your drafts.",
          );
      } else {
        const { draft, capabilities } = await authorized(tx, draftId, actorId);
        if (
          !capabilities.contribute ||
          (input.kind !== "content" && !capabilities.manage)
        )
          throw new DraftError(
            403,
            "Your draft role does not allow this action.",
          );
        if (draft.revision !== input.expectedRevision)
          throw new DraftError(
            409,
            "Draft changed elsewhere. Reload and review saved text before saving again.",
          );
        if (draft.archivedAt && input.kind !== "archive")
          throw new DraftError(409, "Restore this draft before changing it.");
        const changes: Partial<typeof projectDrafts.$inferInsert> = {
          revision,
          updatedAt: new Date(),
          updatedBy: actorId,
        };
        if (input.kind === "content") {
          changes.title = input.title;
          changes.body = input.body;
        } else if (input.kind === "archive")
          changes.archivedAt = input.archived ? new Date() : null;
        else {
          const grants =
            input.mode === "selected"
              ? [...input.members].sort((a, b) =>
                  a.userId.localeCompare(b.userId),
                )
              : [];
          if (input.mode !== "selected" && input.members.length)
            throw new DraftError(
              400,
              "Only selected-member sharing accepts individual grants.",
            );
          if (grants.some((row) => row.userId === draft.ownerId))
            throw new DraftError(400, "The creator already owns this draft.");
          if (grants.length) {
            const active = await tx
              .select({ id: user.id })
              .from(user)
              .where(
                and(
                  inArray(
                    user.id,
                    grants.map((row) => row.userId),
                  ),
                  eq(user.banned, false),
                  membership(tx, user.id),
                ),
              );
            if (active.length !== grants.length)
              throw new DraftError(
                409,
                "Choose current accepted, active members.",
              );
          }
          changes.accessMode = input.mode;
          changes.instanceRole = input.instanceRole;
          await tx
            .delete(projectDraftMembers)
            .where(eq(projectDraftMembers.draftId, draftId));
          if (grants.length)
            await tx
              .insert(projectDraftMembers)
              .values(grants.map((row) => ({ ...row, draftId })));
        }
        await tx
          .update(projectDrafts)
          .set(changes)
          .where(eq(projectDrafts.id, draftId));
      }
      await tx.insert(projectDraftActions).values({
        actorId,
        requestId: input.requestId,
        draftId,
        requestIdentity: identity,
        revision,
      });
      return {
        draft: await snapshot(tx, draftId, actorId),
        savedRevision: revision,
        replayed: false,
      };
    }),
  );
}
/** Fail before activating drafts on a database missing the approved migration. */
export async function verifyDraftSchema(database: typeof db): Promise<void> {
  try {
    await database.select().from(projectDrafts).limit(0);
    await database.select().from(projectDraftMembers).limit(0);
    await database.select().from(projectDraftActions).limit(0);
  } catch (error) {
    throw new Error(
      "Project drafts require migration 0027. Run bun run db:migrate from packages/db.",
      { cause: error },
    );
  }
}
