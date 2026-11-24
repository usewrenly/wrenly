/**
 * Bounded active collaborator list for a shared project workspace header.
 * Call only after verifying read authority; returns display names, roles, and authenticated picture URLs without emails.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import {
  type db,
  instanceSetup,
  member,
  projectMembers,
  user,
} from "@wrenly/db";
import { getProjectAuthors } from "./project-authors";
import type { ProjectRole } from "../access/project-access";

const MAX_PROJECT_COLLABORATORS = 20;

export interface WorkspaceCollaborator {
  id: string;
  name: string;
  role: ProjectRole;
  pictureUrl: string | null;
}

export interface ProjectCollaboratorsSummary {
  collaborators: WorkspaceCollaborator[];
  collaboratorCount: number;
}

/**
 * Resolves owner and active accepted collaborators for non-private projects.
 * Private projects return an empty list so solo headers stay clean.
 */
export async function getProjectCollaborators(
  database: typeof db,
  project: {
    id: string;
    userId: string;
    accessMode: "private" | "selected" | "instance";
    instanceRole: "viewer" | "editor";
  },
): Promise<ProjectCollaboratorsSummary> {
  if (project.accessMode === "private") {
    return { collaborators: [], collaboratorCount: 0 };
  }

  const rawMembers: Array<{ id: string; name: string; role: "viewer" | "editor" }> =
    project.accessMode === "selected"
      ? await database
          .select({
            id: user.id,
            name: user.name,
            role: projectMembers.role,
          })
          .from(projectMembers)
          .innerJoin(user, eq(user.id, projectMembers.userId))
          .innerJoin(member, eq(member.userId, user.id))
          .innerJoin(
            instanceSetup,
            and(
              eq(instanceSetup.id, 1),
              isNotNull(instanceSetup.initializedAt),
              eq(instanceSetup.organizationId, member.organizationId),
            ),
          )
          .where(
            and(
              eq(projectMembers.projectId, project.id),
              eq(user.banned, false),
            ),
          )
      : (
          await database
            .select({
              id: user.id,
              name: user.name,
            })
            .from(member)
            .innerJoin(
              instanceSetup,
              and(
                eq(instanceSetup.id, 1),
                isNotNull(instanceSetup.initializedAt),
                eq(instanceSetup.organizationId, member.organizationId),
              ),
            )
            .innerJoin(user, eq(user.id, member.userId))
            .where(eq(user.banned, false))
        ).map((row) => ({ ...row, role: project.instanceRole }));

  const roles = new Map<string, { role: "viewer" | "editor"; name: string }>();
  for (const row of rawMembers) {
    if (row.id === project.userId) continue;
    roles.set(row.id, {
      role: row.role,
      name: row.name,
    });
  }

  const sortedNonOwners = [...roles.entries()]
    .sort((a, b) => a[1].name.localeCompare(b[1].name) || a[0].localeCompare(b[0]))
    .map(([id, info]) => ({ id, role: info.role }));

  const totalCount = 1 + sortedNonOwners.length;
  const visible = [
    { id: project.userId, role: "owner" as const },
    ...sortedNonOwners.slice(0, MAX_PROJECT_COLLABORATORS - 1),
  ];

  const authors = await getProjectAuthors(
    database,
    visible.map((entry) => entry.id),
  );

  const collaborators: WorkspaceCollaborator[] = [];
  for (const entry of visible) {
    const author = authors.get(entry.id);
    if (!author) continue;
    collaborators.push({
      id: entry.id,
      name: author.name,
      role: entry.role,
      pictureUrl: author.pictureUrl,
    });
  }

  return {
    collaborators,
    collaboratorCount: totalCount,
  };
}
