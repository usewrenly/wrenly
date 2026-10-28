/**
 * Central project access policy.
 * Owner, selected collaborator and accepted instance-member grants resolve to read/contribute/manage/publish capabilities.
 * Instance administration is not project access.
 * Archived projects retain readable history but deny changes.
 * Collection predicates and point checks must remain equivalent.
 */
import {
  and,
  eq,
  exists,
  or,
  isNotNull,
  isNull,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  projects,
  projectMembers,
  projectAccessActions,
  projectModels,
  previewAccess,
  member,
  instanceSetup,
  user,
} from "@wrenly/db";
import {
  AccessDeniedError,
  assertActiveAccount,
  readActivePrincipal,
} from "../../auth/access/access-policy";
import { accessContext } from "../../auth/access/access-context";
import { logger } from "../../../lib/logger";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Database = typeof db | Transaction;
export type ProjectRole = "owner" | "editor" | "viewer";
export interface ProjectCapabilities {
  role: ProjectRole;
  read: true;
  contribute: boolean;
  manage: boolean;
  publish: boolean;
}
interface AccessFacts {
  active: boolean;
  actorId: string;
  ownerId: string;
  mode: "private" | "selected" | "instance";
  archived?: boolean;
  acceptedMember: boolean;
  selectedRole: "viewer" | "editor" | null;
  instanceRole: "viewer" | "editor";
}
export class ProjectAccessError extends Error {
  constructor(
    public readonly status: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "ProjectAccessError";
  }
}

/** Pure policy shared by point lookups and permission-matrix tests. */
export function resolveProjectCapabilities(
  facts: AccessFacts,
): ProjectCapabilities | null {
  if (!facts.active) return null;
  const role: ProjectRole | null =
    facts.ownerId === facts.actorId
      ? "owner"
      : !facts.acceptedMember
        ? null
        : facts.mode === "instance"
          ? facts.instanceRole
          : facts.mode === "selected"
            ? facts.selectedRole
            : null;
  if (!role) return null;
  return {
    role,
    read: true,
    contribute: !facts.archived && role !== "viewer",
    manage: !facts.archived && role === "owner",
    publish: !facts.archived && role === "owner",
  };
}

function acceptedMember(database: Database, actorId: string): SQL {
  return exists(
    database
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

/** Use in database collection queries; callers still require a live session. */
export function readableProjectPredicate(
  database: Database,
  actorId: string,
): SQL {
  const active = exists(
    database
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.id, actorId), eq(user.banned, false))),
  );
  const selected = exists(
    database
      .select({ id: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, actorId),
        ),
      ),
  );
  // These branches deliberately mirror resolveProjectCapabilities; DB tests verify parity.
  const shared = and(
    acceptedMember(database, actorId),
    or(
      eq(projects.accessMode, "instance"),
      and(eq(projects.accessMode, "selected"), selected),
    ),
  );
  const predicate = and(active, or(eq(projects.userId, actorId), shared));
  if (!predicate) throw new Error("Project access predicate unavailable.");
  return predicate;
}

/** No administrator override: creator ownership and accepted project grants are distinct. */
export async function readProjectCapabilities(
  database: Database,
  projectId: string,
  actorId: string,
): Promise<ProjectCapabilities | null> {
  try {
    const principal = accessContext.getStore()?.principal;
    if (principal) {
      const current = await readActivePrincipal(
        database,
        actorId,
        principal.sessionId,
      );
      if (
        principal.userId !== actorId ||
        !current ||
        current.revision !== principal.revision
      )
        return null;
    }
    const [project] = await database
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return null;
    const [account] = await database
      .select({ banned: user.banned })
      .from(user)
      .where(eq(user.id, actorId))
      .limit(1);
    const [membership] = await database
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
      )
      .limit(1);
    const [grant] = await database
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, actorId),
        ),
      )
      .limit(1);
    return resolveProjectCapabilities({
      active: Boolean(account && !account.banned),
      actorId,
      ownerId: project.userId,
      archived: Boolean(project.archivedAt),
      mode: project.accessMode,
      acceptedMember: Boolean(membership),
      selectedRole: grant?.role ?? null,
      instanceRole: project.instanceRole,
    });
  } catch (error) {
    throw new Error("Project access could not be checked.", { cause: error });
  }
}

/** Call after queue locks. Sharing mutations must use the same account → project order. */
export async function requireProjectCapability(
  transaction: Transaction,
  projectId: string,
  actorId: string,
  capability: "read" | "contribute" | "manage" | "publish",
): Promise<ProjectCapabilities> {
  try {
    await assertActiveAccount(transaction, actorId);
    await transaction
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update");
    const result = await readProjectCapabilities(
      transaction,
      projectId,
      actorId,
    );
    if (!result) throw new ProjectAccessError(404, "Project not found.");
    if (!result[capability])
      throw new ProjectAccessError(
        403,
        "Your project role does not allow this action.",
      );
    return result;
  } catch (error) {
    if (
      !(error instanceof ProjectAccessError) &&
      !(error instanceof AccessDeniedError)
    )
      logger.error("Project capability check failed", {
        projectId,
        actorId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    throw error;
  }
}

/** Fail before serving requests whose project queries require the new private-default columns. */
export async function verifyProjectAccessSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database
      .select({
        mode: projects.accessMode,
        role: projects.instanceRole,
        revision: projects.accessRevision,
        media: projects.previewMediaOrigins,
        archivedAt: projects.archivedAt,
      })
      .from(projects)
      .limit(0);
    await database.select().from(projectMembers).limit(0);
    await database.select().from(projectAccessActions).limit(0);
    await database.select().from(projectModels).limit(0);
    await database
      .select({ revision: previewAccess.projectRevision })
      .from(previewAccess)
      .limit(0);
  } catch (error) {
    throw new Error(
      "Project access requires migrations through 0028. Run bun run db:migrate from packages/db.",
      { cause: error },
    );
  }
}

/** Claim queries exclude archived projects even if a malformed/old queued record exists. */
export function unarchivedProjectPredicate(
  database: Pick<typeof db, "select">,
  projectId: string | SQLWrapper,
): SQL {
  return exists(
    database
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.archivedAt))),
  );
}
