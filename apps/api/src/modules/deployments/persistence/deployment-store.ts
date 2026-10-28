/**
 * Durable publishing persistence.
 * Admission freezes an owned successful revision and reserves capacity; claim-fenced operations record mutation intent and acknowledgement.
 * Execution snapshots and encrypted runtime secrets are server-only, distinct from safe status reads.
 */
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { hasDatabaseWork } from "../../databases/database-activity";
import { validateLaravelSource } from "../../../../../../packages/sandbox/src/source-policy/laravel-runtime";
import {
  readableProjectPredicate,
  unarchivedProjectPredicate,
} from "../../projects/access/project-access";
import { assertActiveAccount } from "../../auth/access/access-policy";

import {
  and,
  asc,
  desc,
  count,
  eq,
  inArray,
  lte,
  isNotNull,
  or,
} from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  projects,
  builds,
  deployments,
  deploymentResources,
  deploymentQueue,
  type DeploymentMutationIntent,
} from "../../../../../../packages/db/src/schema";
import { validateDeploymentSource } from "../policy/source-policy";
import { logger } from "../../../lib/logger";
import { randomBytes } from "node:crypto";
import {
  decryptDeploymentSecret,
  encryptDeploymentSecret,
} from "../../../../../../packages/deploy/src/secrets/deployment-secrets";
import {
  validateRuntimeEnvironment,
  laravelRuntimeEnvironment,
} from "../../../../../../packages/deploy/src/secrets/runtime-environment";
import {
  prepareProjectSshKey,
  type ProjectSshKey,
} from "../../../../../../packages/deploy/src/secrets/ssh-keys";

const QUEUE_ID = 1;
const MAX_PENDING_DEPLOYMENTS = 20;
const MAX_RETAINED_ARTIFACTS = 20;
const LEASE_MS = 30_000;
const EXECUTING = ["preparing", "deploying", "verifying"] as const;
const PENDING = ["queued", ...EXECUTING] as const;
const Uuid = z.string().uuid();
const RemoteId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const MutationResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("build_artifact"),
      operationId: Uuid,
      imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      baseImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      sizeBytes: z
        .number()
        .int()
        .positive()
        .max(1024 ** 3),
    })
    .strict(),
  z
    .object({
      kind: z.literal("push_artifact"),
      operationId: Uuid,
      repository: z.string().regex(/^[a-z0-9.:-]+\/[a-z0-9/_-]+$/),
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({ kind: z.literal("update_application"), operationId: Uuid })
    .strict(),
  z
    .object({
      kind: z.literal("create_repository"),
      operationId: Uuid,
      id: RemoteId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("register_git_key"),
      operationId: Uuid,
      id: RemoteId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("register_coolify_key"),
      operationId: Uuid,
      id: RemoteId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_application"),
      operationId: Uuid,
      id: RemoteId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("trigger_deploy"),
      operationId: Uuid,
      id: RemoteId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("push_source"),
      operationId: Uuid,
      commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    })
    .strict(),
  z.object({ kind: z.literal("set_environment"), operationId: Uuid }).strict(),
]);
const TargetSchema = z
  .object({
    gitInstanceUrl: z.url(),
    repositoryOwner: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    coolifyInstanceUrl: z.url(),
    coolifyProjectUuid: z.string().min(1).max(100),
    coolifyServerUuid: z.string().min(1).max(100),
    coolifyEnvironmentName: z.string().min(1).max(100),
    registryOrigin: z.url().optional(),
    registryNamespace: z
      .string()
      .regex(/^[a-z0-9_-]{1,100}$/)
      .optional(),
  })
  .strict();
export type DeploymentTarget = z.infer<typeof TargetSchema>;
type Database = typeof db;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Deployment = typeof deployments.$inferSelect;
export interface DeploymentClaim {
  deploymentId: string;
  token: string;
}
export class DeploymentStoreError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = "DeploymentStoreError";
  }
}

async function operation<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof DeploymentStoreError))
      logger.error("Deployment persistence failed", {
        operation: name,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    throw error;
  }
}
async function lockQueue(transaction: Transaction): Promise<void> {
  await transaction
    .insert(deploymentQueue)
    .values({ id: QUEUE_ID })
    .onConflictDoNothing();
  await transaction
    .select()
    .from(deploymentQueue)
    .where(eq(deploymentQueue.id, QUEUE_ID))
    .for("update");
}
async function lockClaim(
  transaction: Transaction,
  claim: DeploymentClaim,
): Promise<Deployment> {
  const [row] = await transaction
    .select()
    .from(deployments)
    .where(eq(deployments.id, claim.deploymentId))
    .for("update");
  if (
    !row ||
    !EXECUTING.some((status) => row.status === status) ||
    row.claimToken !== claim.token ||
    !row.leaseExpiresAt ||
    row.leaseExpiresAt.getTime() <= Date.now()
  )
    throw new DeploymentStoreError(
      409,
      "Deployment execution no longer owns a valid lease.",
    );
  return row;
}
function parseTarget(input: DeploymentTarget): DeploymentTarget {
  const parsed = TargetSchema.safeParse(input);
  if (!parsed.success)
    throw new DeploymentStoreError(
      400,
      "Deployment target configuration is invalid.",
    );
  for (const value of [
    parsed.data.gitInstanceUrl,
    parsed.data.coolifyInstanceUrl,
    ...(parsed.data.registryOrigin ? [parsed.data.registryOrigin] : []),
  ]) {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new DeploymentStoreError(
        400,
        "Deployment targets must be HTTP(S) origins without embedded credentials.",
      );
  }
  return {
    ...parsed.data,
    gitInstanceUrl: new URL(parsed.data.gitInstanceUrl).origin,
    coolifyInstanceUrl: new URL(parsed.data.coolifyInstanceUrl).origin,
    ...(parsed.data.registryOrigin
      ? { registryOrigin: new URL(parsed.data.registryOrigin).origin }
      : {}),
  };
}

/** Freezes one exact successful revision; this function performs no remote operations. */
export function admitDeployment(
  database: Database,
  input: {
    projectId: string;
    userId: string;
    buildId: string;
    idempotencyKey: string;
    target: DeploymentTarget;
  },
): Promise<{ deploymentId: string; replayed: boolean }> {
  return operation("admit", async () => {
    if (
      ![input.projectId, input.buildId, input.idempotencyKey].every(
        (value) => Uuid.safeParse(value).success,
      )
    )
      throw new DeploymentStoreError(
        400,
        "Provide valid project, build and idempotency UUIDs.",
      );
    const requestIdentity = JSON.stringify([input.projectId, input.buildId]);
    return database.transaction(async (transaction) => {
      await lockQueue(transaction);
      await assertActiveAccount(transaction, input.userId);
      const [project] = await transaction
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.userId, input.userId),
          ),
        )
        .for("update");
      if (!project) throw new DeploymentStoreError(404, "Project not found.");
      if (project.archivedAt)
        throw new DeploymentStoreError(
          409,
          "Restore this project before publishing.",
        );
      const [existing] = await transaction
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.userId, input.userId),
            eq(deployments.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (existing) {
        if (existing.requestIdentity !== requestIdentity)
          throw new DeploymentStoreError(
            409,
            "This idempotency key belongs to another deployment request.",
          );
        return { deploymentId: existing.id, replayed: true };
      }
      if (await hasDatabaseWork(transaction, project.id))
        throw new DeploymentStoreError(
          409,
          "Finish or reconcile database work before publishing.",
        );
      const [active] = await transaction
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.projectId, project.id),
            inArray(deployments.status, [...PENDING, "interrupted"]),
          ),
        )
        .limit(1);
      if (active)
        throw new DeploymentStoreError(
          409,
          "This project has an active or interrupted deployment. Reconcile it before publishing again.",
        );
      const [capacity] = await transaction
        .select({ value: count() })
        .from(deployments)
        .where(inArray(deployments.status, [...PENDING]));
      if ((capacity?.value ?? 0) >= MAX_PENDING_DEPLOYMENTS)
        throw new DeploymentStoreError(
          429,
          "The deployment queue is full. Try again later.",
        );
      // Reserve worst-case 1 GiB per operation, including uncertain uploads. The
      // first release stops admission rather than deleting an image Coolify uses.
      const [retained] = await transaction
        .select({ value: count() })
        .from(deployments)
        .where(
          or(
            isNotNull(deployments.artifactImageId),
            inArray(deployments.status, [...PENDING, "interrupted"]),
          ),
        );
      if ((retained?.value ?? 0) >= MAX_RETAINED_ARTIFACTS)
        throw new DeploymentStoreError(
          429,
          "Publishing artifact retention is full. The instance administrator must reconcile storage before publishing again.",
        );
      const [build] = await transaction
        .select()
        .from(builds)
        .where(
          and(eq(builds.id, input.buildId), eq(builds.projectId, project.id)),
        )
        .for("share");
      if (!build) throw new DeploymentStoreError(404, "Build not found.");
      if (
        build.status !== "success" ||
        (build.stack && build.stack !== project.stack)
      )
        throw new DeploymentStoreError(
          409,
          "Only a successful build matching this project can be published.",
        );
      let source: ReturnType<typeof validateDeploymentSource>;
      try {
        source = validateDeploymentSource(build.files);
        if (project.stack === "laravel") validateLaravelSource(source.files);
      } catch {
        throw new DeploymentStoreError(
          400,
          "This build contains invalid or private deployment source. Review its files and runtime configuration.",
        );
      }
      try {
        if (readAppDatabaseManifest(source.files, project.stack))
          throw new DeploymentStoreError(
            409,
            "This revision declares a database. Publishing requires a separately verified Production database binding; that integration is not enabled yet.",
          );
      } catch (error) {
        if (error instanceof DeploymentStoreError) throw error;
        throw new DeploymentStoreError(
          409,
          "Review this revision’s database manifest and frozen migrations before publishing.",
        );
      }
      const target = parseTarget(input.target);
      if (
        target.registryOrigin &&
        !["nextjs", "laravel"].includes(project.stack)
      )
        throw new DeploymentStoreError(
          400,
          "Image publishing supports Next.js and Laravel 13.",
        );
      const [resources] = await transaction
        .select()
        .from(deploymentResources)
        .where(eq(deploymentResources.projectId, project.id))
        .for("update");
      if (
        resources &&
        Object.entries(target).some(
          ([key, value]) => resources[key as keyof DeploymentTarget] !== value,
        )
      )
        throw new DeploymentStoreError(
          409,
          "Deployment target differs from this project’s saved target. Explicit migration is required.",
        );
      if (!resources)
        await transaction
          .insert(deploymentResources)
          .values({
            projectId: project.id,
            ...target,
            repositoryName: `wrenly-${project.id}`,
          });
      const [saved] = await transaction
        .insert(deployments)
        .values({
          projectId: project.id,
          buildId: build.id,
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
          requestIdentity,
          stack: project.stack,
          files: source.files,
          sourceSha256: source.sha256,
        })
        .returning({ id: deployments.id });
      if (!saved)
        throw new Error("Deployment admission did not return a record.");
      return { deploymentId: saved.id, replayed: false };
    });
  });
}

/** Claims one queued deployment globally; expired claims must be interrupted separately. */
export function claimNextDeployment(
  database: Database,
): Promise<DeploymentClaim | null> {
  return operation("claim", () =>
    database.transaction(async (transaction) => {
      await lockQueue(transaction);
      const [running] = await transaction
        .select({ id: deployments.id })
        .from(deployments)
        .where(inArray(deployments.status, [...EXECUTING]))
        .limit(1);
      if (running) return null;
      const [row] = await transaction
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.status, "queued"),
            unarchivedProjectPredicate(transaction, deployments.projectId),
          ),
        )
        .orderBy(asc(deployments.createdAt), asc(deployments.id))
        .limit(1)
        .for("update");
      if (!row) return null;
      const token = crypto.randomUUID();
      await transaction
        .update(deployments)
        .set({
          status: "preparing",
          claimToken: token,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          updatedAt: new Date(),
        })
        .where(eq(deployments.id, row.id));
      return { deploymentId: row.id, token };
    }),
  );
}

/** Renews only a live claim; an expired token cannot regain ownership. */
export function renewDeploymentLease(
  database: Database,
  claim: DeploymentClaim,
): Promise<void> {
  return operation("renew", () =>
    database.transaction(async (transaction) => {
      await lockClaim(transaction, claim);
      await transaction
        .update(deployments)
        .set({
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          updatedAt: new Date(),
        })
        .where(eq(deployments.id, claim.deploymentId));
    }),
  );
}

/** Prepares server-only secrets under a live claim; corrupt saved keys are never silently replaced. */
export function prepareDeploymentRuntimeEnvironment(
  database: Database,
  claim: DeploymentClaim,
  encryptionKey: string,
): Promise<Record<string, string>> {
  return operation("prepare runtime environment", async () => {
    if (!/^[a-f0-9]{64}$/i.test(encryptionKey))
      throw new DeploymentStoreError(
        400,
        "Deployment encryption configuration is invalid.",
      );
    return database.transaction(async (transaction) => {
      const row = await lockClaim(transaction, claim);
      const [resources] = await transaction
        .select()
        .from(deploymentResources)
        .where(eq(deploymentResources.projectId, row.projectId))
        .for("update");
      if (!resources)
        throw new DeploymentStoreError(
          409,
          "Deployment resources are unavailable.",
        );
      let settings: Record<string, string>;
      try {
        settings = validateRuntimeEnvironment(
          resources.encryptedRuntimeEnvironment === null
            ? {}
            : JSON.parse(
                decryptDeploymentSecret(
                  resources.encryptedRuntimeEnvironment,
                  encryptionKey,
                  row.projectId,
                  "runtime-environment",
                ),
              ),
        );
      } catch {
        throw new DeploymentStoreError(
          409,
          "Saved deployment environment could not be authenticated or validated. Restore its key and configuration.",
        );
      }
      if (row.stack !== "laravel") return settings;
      let appKey: string;
      try {
        appKey =
          resources.encryptedLaravelAppKey === null
            ? `base64:${randomBytes(32).toString("base64")}`
            : decryptDeploymentSecret(
                resources.encryptedLaravelAppKey,
                encryptionKey,
                row.projectId,
                "laravel-app-key",
              );
        const environment = laravelRuntimeEnvironment(settings, appKey);
        if (resources.encryptedLaravelAppKey === null)
          await transaction
            .update(deploymentResources)
            .set({
              encryptedLaravelAppKey: encryptDeploymentSecret(
                appKey,
                encryptionKey,
                row.projectId,
                "laravel-app-key",
              ),
              updatedAt: new Date(),
            })
            .where(eq(deploymentResources.projectId, row.projectId));
        return environment;
      } catch {
        throw new DeploymentStoreError(
          409,
          "Saved Laravel key could not be authenticated or validated. Restore its key and configuration.",
        );
      }
    });
  });
}

/** Persists one encrypted project SSH key before remote registration; missing registered keys require restore. */
export function prepareDeploymentSshKey(
  database: Database,
  claim: DeploymentClaim,
  encryptionKey: string,
): Promise<ProjectSshKey> {
  return operation("prepare SSH key", () =>
    database.transaction(async (transaction) => {
      const row = await lockClaim(transaction, claim);
      const [resources] = await transaction
        .select()
        .from(deploymentResources)
        .where(eq(deploymentResources.projectId, row.projectId))
        .for("update");
      if (
        !resources ||
        (resources.encryptedDeployPrivateKey === null &&
          (resources.gitDeployKeyId !== null ||
            resources.coolifyPrivateKeyUuid !== null))
      )
        throw new DeploymentStoreError(
          409,
          "Registered project SSH key is missing. Restore it before publishing.",
        );
      const privateKey =
        resources.encryptedDeployPrivateKey === null
          ? undefined
          : decryptDeploymentSecret(
              resources.encryptedDeployPrivateKey,
              encryptionKey,
              row.projectId,
              "git-deploy-private-key",
            );
      const key = await prepareProjectSshKey(privateKey);
      await lockClaim(transaction, claim);
      if (privateKey === undefined)
        await transaction
          .update(deploymentResources)
          .set({
            encryptedDeployPrivateKey: encryptDeploymentSecret(
              key.privateKey,
              encryptionKey,
              row.projectId,
              "git-deploy-private-key",
            ),
            updatedAt: new Date(),
          })
          .where(eq(deploymentResources.projectId, row.projectId));
      return key;
    }),
  );
}

/** Persists one pending mutation before remote calls; an unresolved intent cannot be overwritten. */
export function beginDeploymentMutation(
  database: Database,
  claim: DeploymentClaim,
  kind: DeploymentMutationIntent["kind"],
): Promise<DeploymentMutationIntent> {
  return operation("begin mutation", () =>
    database.transaction(async (transaction) => {
      const row = await lockClaim(transaction, claim);
      if (row.mutationIntent)
        throw new DeploymentStoreError(
          409,
          "An unresolved remote operation requires reconciliation.",
        );
      const intent: DeploymentMutationIntent = {
        kind,
        operationId: crypto.randomUUID(),
      };
      await transaction
        .update(deployments)
        .set({ mutationIntent: intent, updatedAt: new Date() })
        .where(eq(deployments.id, row.id));
      return intent;
    }),
  );
}

/** Atomically records a remote result and clears only the matching pending intent. */
export function completeDeploymentMutation(
  database: Database,
  claim: DeploymentClaim,
  result: unknown,
): Promise<void> {
  return operation("complete mutation", async () => {
    const parsed = MutationResultSchema.safeParse(result);
    if (!parsed.success)
      throw new DeploymentStoreError(
        400,
        "Invalid deployment operation result.",
      );
    const output = parsed.data;
    await database.transaction(async (transaction) => {
      const row = await lockClaim(transaction, claim);
      if (
        row.mutationIntent?.kind !== output.kind ||
        row.mutationIntent.operationId !== output.operationId
      )
        throw new DeploymentStoreError(
          409,
          "Deployment operation result does not match its saved intent.",
        );
      const resourceFields = {
        create_repository: "repositoryId",
        register_git_key: "gitDeployKeyId",
        register_coolify_key: "coolifyPrivateKeyUuid",
        create_application: "coolifyApplicationUuid",
      } as const;
      if (output.kind in resourceFields && "id" in output) {
        const field =
          resourceFields[output.kind as keyof typeof resourceFields];
        await transaction
          .update(deploymentResources)
          .set({ [field]: output.id, updatedAt: new Date() })
          .where(eq(deploymentResources.projectId, row.projectId));
      }
      await transaction
        .update(deployments)
        .set({
          mutationIntent: null,
          updatedAt: new Date(),
          ...(output.kind === "push_source"
            ? { gitCommitSha: output.commitSha }
            : {}),
          ...(output.kind === "build_artifact"
            ? {
                artifactImageId: output.imageId,
                artifactBaseImageId: output.baseImageId,
                artifactSizeBytes: output.sizeBytes,
              }
            : {}),
          ...(output.kind === "push_artifact"
            ? {
                registryRepository: output.repository,
                registryDigest: output.digest,
              }
            : {}),
          ...(output.kind === "trigger_deploy"
            ? { remoteDeploymentUuid: output.id, status: "deploying" as const }
            : {}),
        })
        .where(eq(deployments.id, row.id));
    });
  });
}

/** Separates a finished provider job from HTTP verification without changing its saved remote identity. */
export function markDeploymentVerifying(database: Database, claim: DeploymentClaim): Promise<void> {
  return operation("verify routed application", () => database.transaction(async transaction => {
    const row = await lockClaim(transaction, claim);
    if (row.mutationIntent || !row.remoteDeploymentUuid || !["deploying", "verifying"].includes(row.status))
      throw new DeploymentStoreError(409, "A completed remote deployment job is required before URL verification.");
    await transaction.update(deployments).set({ status: "verifying", updatedAt: new Date() }).where(eq(deployments.id, row.id));
  }));
}

/** Marks expired work interrupted while preserving remote mutation intent for reconciliation. */
export function interruptExpiredDeployments(
  database: Database,
): Promise<number> {
  return operation("interrupt expired", () =>
    database.transaction(async (transaction) => {
      await lockQueue(transaction);
      const rows = await transaction
        .select()
        .from(deployments)
        .where(
          and(
            inArray(deployments.status, [...EXECUTING]),
            lte(deployments.leaseExpiresAt, new Date()),
          ),
        )
        .for("update");
      for (const row of rows)
        await transaction
          .update(deployments)
          .set({
            status: "interrupted",
            claimToken: null,
            leaseExpiresAt: null,
            errorCode: "EXECUTION_INTERRUPTED",
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(deployments.id, row.id));
      return rows.length;
    }),
  );
}

/** Returns an allowlisted owner-facing projection, excluding snapshots, claims and credentials. */
export function getOwnedDeployment(
  database: Database,
  userId: string,
  projectId: string,
  deploymentId: string,
): Promise<{
  id: string;
  buildId: string;
  status: Deployment["status"];
  url: string | null;
  errorCode: string | null;
} | null> {
  return operation("owned status", async () => {
    if (
      ![projectId, deploymentId].every((value) => Uuid.safeParse(value).success)
    )
      return null;
    const [row] = await database
      .select({
        id: deployments.id,
        buildId: deployments.buildId,
        status: deployments.status,
        url: deployments.url,
        errorCode: deployments.errorCode,
      })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.projectId))
      .where(
        and(
          eq(deployments.id, deploymentId),
          eq(deployments.projectId, projectId),
          readableProjectPredicate(database, userId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/** Loads server-only execution state under the claim fence. Never return this from HTTP handlers. */
export function loadDeploymentExecution(
  database: Database,
  claim: DeploymentClaim,
): Promise<{
  deployment: Deployment;
  resources: typeof deploymentResources.$inferSelect;
}> {
  return operation("load execution", () =>
    database.transaction(async (transaction) => {
      const deployment = await lockClaim(transaction, claim);
      const [resources] = await transaction
        .select()
        .from(deploymentResources)
        .where(eq(deploymentResources.projectId, deployment.projectId));
      if (!resources)
        throw new DeploymentStoreError(
          409,
          "Deployment resources are unavailable.",
        );
      return { deployment, resources };
    }),
  );
}

/** Finalizes an owned outcome; uncertain remote mutations remain interrupted and block replay. */
export function finishDeployment(
  database: Database,
  claim: DeploymentClaim,
  outcome:
    | { status: "success"; url: string }
    | {
        status: "failed" | "interrupted";
        code:
          | "PROVIDER_FAILURE"
          | "EXECUTION_INTERRUPTED"
          | "VERIFICATION_FAILED"
          | "SOURCE_SYNC_FAILED"
          | "ARTIFACT_BUILD_FAILED"
          | "REGISTRY_UPLOAD_UNCONFIRMED"
          | "APPLICATION_CONFIGURATION_FAILED"
          | "READINESS_UNCONFIRMED";
      },
): Promise<void> {
  return operation("finish", () =>
    database.transaction(async (transaction) => {
      const row = await lockClaim(transaction, claim);
      if (
        outcome.status === "success" &&
        (row.mutationIntent ||
          !row.registryDigest ||
          !row.artifactImageId ||
          !row.remoteDeploymentUuid)
      )
        throw new DeploymentStoreError(
          409,
          "Deployment completion lacks confirmed remote evidence.",
        );
      let url: string | null = null;
      if (outcome.status === "success") {
        const parsed = new URL(outcome.url);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash
        )
          throw new DeploymentStoreError(
            400,
            "Deployment returned an invalid application URL.",
          );
        url = parsed.href;
      }
      const status =
        row.mutationIntent && outcome.status !== "success"
          ? "interrupted"
          : outcome.status;
      await transaction
        .update(deployments)
        .set({
          status,
          url,
          errorCode: outcome.status === "success" ? null : outcome.code,
          claimToken: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(deployments.id, row.id));
      if (outcome.status === "success")
        await transaction
          .update(builds)
          .set({ deployedUrl: url })
          .where(eq(builds.id, row.buildId));
    }),
  );
}

/** Lists expired claims without releasing their reservation; the worker must prove quiescence first. */
export function getExpiredDeploymentClaims(
  database: Database,
): Promise<DeploymentClaim[]> {
  return operation("expired claims", async () => {
    const rows = await database
      .select({ deploymentId: deployments.id, token: deployments.claimToken })
      .from(deployments)
      .where(
        and(
          inArray(deployments.status, [...EXECUTING]),
          lte(deployments.leaseExpiresAt, new Date()),
        ),
      );
    return rows.flatMap((row) =>
      row.token ? [{ deploymentId: row.deploymentId, token: row.token }] : [],
    );
  });
}

/** Interrupts only the expired token whose external executor was fenced by the caller. */
export function interruptQuiescentDeployment(
  database: Database,
  claim: DeploymentClaim,
): Promise<void> {
  return operation("interrupt quiescent claim", async () => {
    await database
      .update(deployments)
      .set({
        status: "interrupted",
        errorCode: "EXECUTION_INTERRUPTED",
        claimToken: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(deployments.id, claim.deploymentId),
          eq(deployments.claimToken, claim.token),
          inArray(deployments.status, [...EXECUTING]),
          lte(deployments.leaseExpiresAt, new Date()),
        ),
      );
  });
}

/** Restores the most recent deployment for one owned selected revision. */
export function getLatestOwnedDeployment(
  database: Database,
  userId: string,
  projectId: string,
  buildId: string,
): ReturnType<typeof getOwnedDeployment> {
  return operation("latest owned deployment", async () => {
    if (![projectId, buildId].every((value) => Uuid.safeParse(value).success))
      return null;
    const [row] = await database
      .select({ id: deployments.id })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.projectId))
      .where(
        and(
          eq(deployments.projectId, projectId),
          eq(deployments.buildId, buildId),
          readableProjectPredicate(database, userId),
        ),
      )
      .orderBy(desc(deployments.createdAt), desc(deployments.id))
      .limit(1);
    return row ? getOwnedDeployment(database, userId, projectId, row.id) : null;
  });
}

/** Withdraws only an owned unclaimed operation; running remote work is never reported cancelled. */
export function cancelQueuedDeployment(
  database: Database,
  userId: string,
  projectId: string,
  id: string,
): Promise<void> {
  return operation("cancel queued deployment", () =>
    database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.id, id),
            eq(deployments.projectId, projectId),
            eq(deployments.userId, userId),
          ),
        )
        .for("update");
      const [project] = await transaction
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
      if (!row || !project)
        throw new DeploymentStoreError(404, "Deployment not found.");
      if (row.status === "cancelled") return;
      if (row.status !== "queued")
        throw new DeploymentStoreError(
          409,
          "Publishing has already started. Track its status; the instance administrator can cancel the exact remote job.",
        );
      await transaction
        .update(deployments)
        .set({
          status: "cancelled",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(deployments.id, id));
    }),
  );
}
