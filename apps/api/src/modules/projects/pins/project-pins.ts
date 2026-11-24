/*
COMPONENT: project-pins
PURPOSE: Persist per-user pinned project preferences with strict project-read authorization and per-account limits.
INPUTS:
  - database: Drizzle database instance
  - projectId: UUID of the project to pin or unpin
  - actorId: Authenticated active user ID
  - pinned: Desired pin state (`true` to pin, `false` to unpin)
OUTPUTS:
  - { projectId, pinned, pinnedAt } where pinnedAt is an ISO-8601 timestamp when pinned or null when unpinned.
STEPS:
  1. Run inside a Drizzle transaction and verify the actor account is active.
  2. Verify current project read capabilities via readProjectCapabilities; reject inaccessible/archived visibility consistently with 404.
  3. On pin, return idempotently if already pinned, enforce MAX_PINNED_PROJECTS per user, and insert `(actorId, projectId)`.
  4. On unpin, delete the user's pin row and return `{ pinned: false, pinnedAt: null }`.
EDGE CASES:
  - Duplicate concurrent pin writes -> `.onConflictDoNothing()` + select guarantees idempotent timestamp return.
  - Project is private/revoked -> throws ProjectAccessError(404).
ERROR STATES:
  - More than 20 pinned projects for the actor -> throws ProjectPinError(409).
*/

import { and, count, eq } from "drizzle-orm";
import { db, projectPins } from "@wrenly/db";
import { assertActiveAccount } from "../../auth/access/access-policy";
import {
  ProjectAccessError,
  readProjectCapabilities,
} from "../access/project-access";

export const MAX_PINNED_PROJECTS = 20;

export class ProjectPinError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ProjectPinError";
  }
}

export interface ProjectPinState {
  projectId: string;
  pinned: boolean;
  pinnedAt: string | null;
}

/**
 * Sets or clears a personal project pin for an authorized project viewer, editor, or owner.
 */
export async function setProjectPin(
  database: typeof db,
  projectId: string,
  actorId: string,
  pinned: boolean,
): Promise<ProjectPinState> {
  return database.transaction(async (tx) => {
    await assertActiveAccount(tx, actorId);
    const capabilities = await readProjectCapabilities(tx, projectId, actorId);
    if (!capabilities) {
      throw new ProjectAccessError(404, "Project not found.");
    }
    const [existing] = await tx
      .select({ pinnedAt: projectPins.pinnedAt })
      .from(projectPins)
      .where(
        and(
          eq(projectPins.userId, actorId),
          eq(projectPins.projectId, projectId),
        ),
      );
    if (!pinned) {
      if (existing) {
        await tx
          .delete(projectPins)
          .where(
            and(
              eq(projectPins.userId, actorId),
              eq(projectPins.projectId, projectId),
            ),
          );
      }
      return { projectId, pinned: false, pinnedAt: null };
    }
    if (existing) {
      return {
        projectId,
        pinned: true,
        pinnedAt: existing.pinnedAt.toISOString(),
      };
    }
    const [pinnedCount] = await tx
      .select({ value: count() })
      .from(projectPins)
      .where(eq(projectPins.userId, actorId));
    if ((pinnedCount?.value ?? 0) >= MAX_PINNED_PROJECTS) {
      throw new ProjectPinError(
        409,
        `You can pin up to ${MAX_PINNED_PROJECTS} projects. Unpin another project first.`,
      );
    }
    await tx
      .insert(projectPins)
      .values({ userId: actorId, projectId })
      .onConflictDoNothing();
    const [saved] = await tx
      .select({ pinnedAt: projectPins.pinnedAt })
      .from(projectPins)
      .where(
        and(
          eq(projectPins.userId, actorId),
          eq(projectPins.projectId, projectId),
        ),
      );
    return {
      projectId,
      pinned: true,
      pinnedAt: (saved?.pinnedAt ?? new Date()).toISOString(),
    };
  });
}

/**
 * Verifies at startup that migration 0053 (`project_pins`) has been applied.
 */
export async function verifyProjectPinsSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database
      .select({ projectId: projectPins.projectId })
      .from(projectPins)
      .limit(0);
  } catch (error) {
    throw new Error(
      "Project pins require migration 0053. Run bun run db:migrate before starting Wrenly.",
      { cause: error },
    );
  }
}
