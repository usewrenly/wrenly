/**
 * Owner project metadata persistence.
 * Returns a safe details projection and compares reviewed values inside an account/project transaction.
 * Archived projects reject writes; exact retry cannot overwrite a later change.
 */
import {
  assertActiveAccount,
  AccessDeniedError,
} from "../../auth/access/access-policy";
import type { db } from "@wrenly/db";
import { projects } from "@wrenly/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  ProjectSettingsError,
  type ProjectDetails,
  type SettingsInput,
} from "./settings-contract";
const projection = {
  id: projects.id,
  name: projects.name,
  description: projects.description,
  stack: projects.stack,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};
/** Reads an owned, bounded settings projection without source, credentials or ownership identifiers. */
export async function readProjectSettings(
  database: typeof db,
  userId: string,
  id: string,
): Promise<ProjectDetails> {
  try {
    const [project] = await database
      .select(projection)
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .limit(1);
    if (!project) throw new ProjectSettingsError(404, "Project not found.");
    return { ...project, access: "private" };
  } catch (error) {
    throw error instanceof ProjectSettingsError ||
      error instanceof AccessDeniedError
      ? error
      : new Error("Project settings read failed.", { cause: error });
  }
}
/** Atomically compares reviewed metadata; identical retries acknowledge a save without overwriting intervening edits. */
export async function saveProjectSettings(
  database: typeof db,
  userId: string,
  id: string,
  input: SettingsInput,
): Promise<ProjectDetails> {
  try {
    const [saved] = await database.transaction(async (tx) => {
      await assertActiveAccount(tx, userId);
      const [project] = await tx
        .select({ archivedAt: projects.archivedAt })
        .from(projects)
        .where(and(eq(projects.id, id), eq(projects.userId, userId)))
        .for("update");
      if (!project) throw new ProjectSettingsError(404, "Project not found.");
      if (project.archivedAt)
        throw new ProjectSettingsError(
          409,
          "Restore this project before changing its details.",
        );
      return tx
        .update(projects)
        .set({
          name: input.name,
          description: input.description,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projects.id, id),
            eq(projects.userId, userId),
            eq(projects.name, input.expected.name),
            input.expected.description === null
              ? isNull(projects.description)
              : eq(projects.description, input.expected.description),
          ),
        )
        .returning(projection);
    });
    if (saved) return { ...saved, access: "private" };
    const current = await readProjectSettings(database, userId, id);
    if (
      current.name === input.name &&
      current.description === input.description
    )
      return current;
    throw new ProjectSettingsError(
      409,
      "Project details changed elsewhere. Review the saved details before saving again.",
      current,
    );
  } catch (error) {
    throw error instanceof ProjectSettingsError ||
      error instanceof AccessDeniedError
      ? error
      : new Error("Project settings save failed.", { cause: error });
  }
}
