/**
 * Authorized build snapshots and progress replay.
 * Browser reconnects read saved state and ordered events instead of starting execution.
 * Current project access is checked; response projections exclude claim tokens, private job inputs and provider credentials.
 */
import { parseSkillGuidance } from "@wrenly/inference";
import { readableProjectPredicate } from "../../projects/access/project-access";
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  lte,
  desc,
  count,
  lt,
  or,
} from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  builds,
  projects,
  buildJobs,
  buildEvents,
} from "../../../../../../packages/db/src/schema";

const MAX_ACTIVITY_EVENTS = 64;
const EVENT_BATCH_SIZE = 100;

export interface BuildSnapshot {
  build: typeof builds.$inferSelect;
  outcome: (typeof buildJobs.$inferSelect)["status"] | null;
  cursor: number;
  skillsUsed?: Array<{ name: string; versionId: string; sha256: string }>;
  activity?: Array<{
    sequence: number;
    attempt: number;
    operation: string;
    state: string;
    occurredAt: string;
  }>;
  queue?: { position: number; reason: "waiting" | "busy" | "recovering" };
}
export type SavedBuildEvent = typeof buildEvents.$inferSelect;

/** Joins snapshot and cursor in one statement to avoid dropping events during hydration. */
export async function getOwnedBuild(
  database: typeof db,
  buildId: string,
  userId: string,
): Promise<BuildSnapshot | null> {
  try {
    const [row] = await database
      .select({
        input: buildJobs.input,
        build: getTableColumns(builds),
        outcome: buildJobs.status,
        queuedAt: buildJobs.createdAt,
        nextSequence: buildJobs.nextEventSequence,
      })
      .from(builds)
      .innerJoin(projects, eq(projects.id, builds.projectId))
      .leftJoin(buildJobs, eq(buildJobs.buildId, builds.id))
      .where(
        and(eq(builds.id, buildId), readableProjectPredicate(database, userId)),
      )
      .limit(1);
    if (!row) return null;
    const snapshot: BuildSnapshot = {
      build: row.build,
      outcome: row.outcome,
      cursor: (row.nextSequence ?? 1) - 1,
    };
    snapshot.skillsUsed = parseSkillGuidance(row.input?.skillsV1).skills.map(
      ({ name, versionId, sha256 }) => ({ name, versionId, sha256 }),
    );
    const activity = await database
      .select({ sequence: buildEvents.sequence, data: buildEvents.data })
      .from(buildEvents)
      .innerJoin(buildJobs, eq(buildJobs.buildId, buildEvents.buildId))
      .innerJoin(projects, eq(projects.id, buildJobs.projectId))
      .where(
        and(
          eq(buildEvents.buildId, buildId),
          eq(buildEvents.type, "activity_v1"),
          lte(buildEvents.sequence, snapshot.cursor),
          readableProjectPredicate(database, userId),
        ),
      )
      .orderBy(desc(buildEvents.sequence))
      .limit(MAX_ACTIVITY_EVENTS);
    snapshot.activity = activity
      .reverse()
      .map(({ sequence, data }) => ({
        sequence,
        attempt: Number(data.attempt),
        operation: String(data.operation),
        state: String(data.state),
        occurredAt: String(data.occurredAt),
      }));
    if (row.outcome === "queued") {
      const queuedAt = row.queuedAt ?? row.build.createdAt;
      const [ahead] = await database
        .select({ total: count() })
        .from(buildJobs)
        .where(
          and(
            eq(buildJobs.status, "queued"),
            or(
              lt(buildJobs.createdAt, queuedAt),
              and(
                eq(buildJobs.createdAt, queuedAt),
                lt(buildJobs.buildId, buildId),
              ),
            ),
          ),
        );
      const [running] = await database
        .select({ lease: buildJobs.leaseExpiresAt })
        .from(buildJobs)
        .where(eq(buildJobs.status, "running"))
        .limit(1);
      snapshot.queue = {
        position: (ahead?.total ?? 0) + 1,
        reason: !running
          ? "waiting"
          : !running.lease || running.lease.getTime() <= Date.now()
            ? "recovering"
            : "busy",
      };
    }
    return snapshot;
  } catch (error) {
    throw new Error("Build state could not be loaded.", { cause: error });
  }
}

/** Rechecks ownership on every batch, including after a stream is already open. */
export async function getOwnedBuildEvents(
  database: typeof db,
  buildId: string,
  userId: string,
  after: number,
): Promise<SavedBuildEvent[]> {
  if (!Number.isSafeInteger(after) || after < 0)
    throw new Error("Invalid event cursor.");
  try {
    return await database
      .select(getTableColumns(buildEvents))
      .from(buildEvents)
      .innerJoin(buildJobs, eq(buildJobs.buildId, buildEvents.buildId))
      .innerJoin(projects, eq(projects.id, buildJobs.projectId))
      .where(
        and(
          eq(buildEvents.buildId, buildId),
          readableProjectPredicate(database, userId),
          gt(buildEvents.sequence, after),
        ),
      )
      .orderBy(asc(buildEvents.sequence))
      .limit(EVENT_BATCH_SIZE);
  } catch (error) {
    throw new Error("Build events could not be loaded.", { cause: error });
  }
}
