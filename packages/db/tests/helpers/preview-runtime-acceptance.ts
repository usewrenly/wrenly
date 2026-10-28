/** Real control storage/key/kernel checks with synthetic Docker identities; no application connection is opened. */
import { expect } from "bun:test";
import { verifyPreviewWorker } from "./preview-worker-acceptance";
import { verifyPreviewStartup } from "./preview-startup-acceptance";
import { verifyDatabasePreviewAccess } from "./preview-database-access-acceptance";
import { databasePreviewIsReady } from "../../../../apps/api/src/modules/databases/bindings/preview-readiness";
import { verifyPreviewPreparation } from "./preview-preparation-acceptance";
import { cleanupPreviewDatabaseRuntime, type PreviewDatabaseCleanupAdapters } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-cleanup";
import { cleanupPreviewDatabaseApplication } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-application";
import { cleanupPreviewDatabaseSessions } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-sessions";
import { cleanupPreviewDatabaseArtifact } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-artifact";
import {
  openPreviewDatabaseSocket,
  cleanupPreviewDatabaseSocket,
} from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-socket";
import { and, eq } from "drizzle-orm";
import { join } from "node:path";
import type { db } from "@wrenly/db";
import * as schema from "../../src/schema";
import {
  admitDatabasePreview,
  stopPreview,
  updatePreviewProgress,
} from "../../../../apps/api/src/modules/previews/persistence/preview-store";
import { acquirePreviewExecutorLock } from "../../../../apps/api/src/modules/previews/execution/preview-executor-lock";
import { claimNextDatabasePreview } from "../../../../apps/api/src/modules/databases/bindings/preview-claim";
import { createDatabaseCredentials } from "../../../../apps/api/src/modules/databases/database-contract";
import {
  encryptDatabaseSecret,
  loadDatabaseKey,
} from "../../../../apps/api/src/modules/databases/database-secrets";
import { loadPreviewDatabaseConnection } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-connection";
import {
  recordPreviewDatabaseEffect,
  acknowledgePreviewDatabaseEffect,
} from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-store";
import {
  beginPreviewDatabaseCleanup,
  assertPreviewDatabaseCleanup,
  renewPreviewDatabaseCleanup,
  recordPreviewDatabaseCleanup,
  acknowledgePreviewDatabaseCleanup,
  finishPreviewDatabaseCleanup,
} from "../../../../apps/api/src/modules/databases/preview-runtime/cleanup-store";

/** Exercises both an acknowledged runtime and cleanup after an expired/revoked uncertain preparation. */
export async function verifyPreviewRuntimeStorage(
  database: typeof db,
  directory: string,
  projectId: string,
  buildId: string,
  resourceId: string,
  resourceRevision: string,
): Promise<void> {
  const [original] = await database
    .select()
    .from(schema.appDatabases)
    .where(eq(schema.appDatabases.id, resourceId));
  if (!original) throw new Error("Missing fixture resource");
  const key = await loadDatabaseKey(join(directory, "database-keys"), false);
  const credentials = createDatabaseCredentials(resourceId);
  const identity = {
    version: 1 as const,
    containerId: "a".repeat(64),
    networkId: "b".repeat(64),
    volumeName: `wrenly-database-${resourceId}-data`,
    imageId: `sha256:${"c".repeat(64)}`,
  };
  const secrets = encryptDatabaseSecret(
    JSON.stringify(credentials),
    key,
    `${resourceId}:development`,
  );
  try {
    await database
      .update(schema.appDatabases)
      .set({ secrets, runtimeIdentity: identity })
      .where(eq(schema.appDatabases.id, resourceId));
    if (process.env.WRENLY_TEST_DATABASE_PREVIEW_WORKER_ONLY === "true") {
      await verifyPreviewWorker(database, directory, projectId, buildId, resourceId, resourceRevision);
      return;
    }
    await verifyPreviewPreparation(database, projectId, buildId, resourceId, resourceRevision);
    await verifyPreviewStartup(database, directory, buildId, resourceId, resourceRevision);
    for (const scenario of [
      "known",
      "preparation-unknown",
      "socket-unknown",
      "sequence",
    ] as const) {
      const unknownPreparation = scenario === "preparation-unknown";
      const unknownSocket = scenario === "socket-unknown";
      const admitted = await admitDatabasePreview(
        database,
        buildId,
        "db-editor",
        crypto.randomUUID(),
        {
          version: 1,
          environment: "development",
          resourceId,
          resourceRevision,
        },
      );
      const claim = await claimNextDatabasePreview(database);
      if (!claim || claim.previewId !== admitted.previewId)
        throw new Error("Expected fixture database preview claim");
      const lock = await acquirePreviewExecutorLock(claim);
      const held = (): void => lock.assertHeld();
      try {
        const verifyConnection = async (): Promise<void> => {
          const loaded = await loadPreviewDatabaseConnection(
            database,
            claim,
            directory,
            held,
          );
          expect(loaded).toEqual({ identity, role: credentials.runtime });
          for (const role of [
            credentials.administrator,
            credentials.migrator,
            credentials.reader,
          ])
            expect(JSON.stringify(loaded)).not.toContain(role.password);
          expect(Object.keys(loaded).sort()).toEqual(["identity", "role"]);
          await expect(
            loadPreviewDatabaseConnection(database, claim, directory, () => {
              throw new Error("Lost kernel lock");
            }),
          ).rejects.toMatchObject({ status: 409 });
          await database
            .update(schema.appDatabases)
            .set({
              secrets: encryptDatabaseSecret(
                JSON.stringify(credentials),
                key,
                `${crypto.randomUUID()}:development`,
              ),
            })
            .where(eq(schema.appDatabases.id, resourceId));
          await expect(
            loadPreviewDatabaseConnection(database, claim, directory, held),
          ).rejects.toMatchObject({ status: 409 });
          await database
            .update(schema.appDatabases)
            .set({
              secrets: encryptDatabaseSecret(
                JSON.stringify({ ...credentials, runtime: credentials.reader }),
                key,
                `${resourceId}:development`,
              ),
            })
            .where(eq(schema.appDatabases.id, resourceId));
          await expect(
            loadPreviewDatabaseConnection(database, claim, directory, held),
          ).rejects.toMatchObject({ status: 409 });
          await database
            .update(schema.appDatabases)
            .set({ secrets })
            .where(eq(schema.appDatabases.id, resourceId));
        };
        await expect(
          loadPreviewDatabaseConnection(database, claim, directory, held),
        ).rejects.toMatchObject({ status: 409 });

        await expect(
          recordPreviewDatabaseEffect(database, claim, "create-socket", held),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
          recordPreviewDatabaseEffect(
            database,
            claim,
            "prepare-artifact",
            async () => {
              await Promise.resolve();
              throw new Error("Asynchronous kernel ownership lost");
            },
          ),
        ).rejects.toMatchObject({ status: 409 });
        expect(
          (
            await database
              .select()
              .from(schema.previewDatabaseRuntime)
              .where(
                eq(schema.previewDatabaseRuntime.previewId, claim.previewId),
              )
          )[0]?.effect,
        ).toBeNull();
        await recordPreviewDatabaseEffect(
          database,
          claim,
          "prepare-artifact",
          held,
        );
        await expect(
          recordPreviewDatabaseEffect(
            database,
            claim,
            "prepare-artifact",
            held,
          ),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
          acknowledgePreviewDatabaseEffect(
            database,
            claim,
            "create-socket",
            {},
            held,
          ),
        ).rejects.toMatchObject({ status: 409 });
        if (!unknownPreparation) {
          await expect(
            acknowledgePreviewDatabaseEffect(
              database,
              claim,
              "prepare-artifact",
              { imageId: "not-an-image" },
              held,
            ),
          ).rejects.toMatchObject({ status: 409 });
          await acknowledgePreviewDatabaseEffect(
            database,
            claim,
            "prepare-artifact",
            { imageId: `sha256:${"d".repeat(64)}` },
            held,
          );
          await verifyConnection();
          await expect(
            acknowledgePreviewDatabaseEffect(
              database,
              claim,
              "prepare-artifact",
              { imageId: `sha256:${"e".repeat(64)}` },
              held,
            ),
          ).rejects.toMatchObject({ status: 409 });
          const socket = {
            id: claim.previewId,
            projectId,
            resourceId,
            containerId: "e".repeat(64),
            imageId: `sha256:${"f".repeat(64)}`,
            volumeName: `wrenly-database-socket-${claim.previewId}`,
          };
          let startCalls = 0;
          const opening = openPreviewDatabaseSocket(
            database,
            claim,
            directory,
            new AbortController().signal,
            held,
            async (input) => {
              startCalls++;
              expect(input.scope).toEqual({
                projectId,
                resourceId,
                environment: "development",
              });
              expect(input.role).toEqual({
                kind: "runtime",
                ...credentials.runtime,
              });
              const effect = {
                kind: "create-socket" as const,
                id: socket.volumeName,
              };
              await input.fence.beforeEffect(effect);
              if (unknownSocket)
                throw new Error("PRIVATE_SOCKET_STARTUP_UNKNOWN");
              await expect(
                acknowledgePreviewDatabaseEffect(
                  database,
                  claim,
                  "create-socket",
                  { ...socket, resourceId: crypto.randomUUID() },
                  held,
                ),
              ).rejects.toMatchObject({ status: 409 });
              await input.fence.acknowledgeEffect(effect);
              return socket;
            },
          );
          if (unknownSocket) {
            await expect(opening).rejects.toMatchObject({ status: 409 });
            expect(startCalls).toBe(1);
            expect(
              (
                await database
                  .select()
                  .from(schema.previews)
                  .where(eq(schema.previews.id, claim.previewId))
              )[0]?.status,
            ).toBe("interrupted");
          } else {
            const opened = await opening;
            expect(opened).toEqual(socket);
            expect(JSON.stringify(opened)).not.toContain(
              credentials.runtime.password,
            );
            await recordPreviewDatabaseEffect(
              database,
              claim,
              "start-application",
              held,
            );
            await expect(
              acknowledgePreviewDatabaseEffect(
                database,
                claim,
                "start-application",
                {},
                held,
              ),
            ).rejects.toMatchObject({ status: 409 });
            await updatePreviewProgress(database, claim, {
              type: "starting",
              resources: {
                appContainerId: "1".repeat(64),
                ingressContainerId: "2".repeat(64),
                appNetworkId: "3".repeat(64),
                ingressNetworkId: "4".repeat(64),
                preparation: {
                  imageId: `sha256:${"d".repeat(64)}`,
                  lockfileSha256: null,
                },
              },
            });
            const [started] = await database
              .select()
              .from(schema.previews)
              .where(eq(schema.previews.id, claim.previewId));
            if (!started?.resources)
              throw new Error("Missing fixture startup resources");
            await database
              .update(schema.previews)
              .set({
                resources: {
                  ...started.resources,
                  preparation: {
                    imageId: `sha256:${"9".repeat(64)}`,
                    lockfileSha256: null,
                  },
                },
              })
              .where(eq(schema.previews.id, claim.previewId));
            await expect(
              acknowledgePreviewDatabaseEffect(
                database,
                claim,
                "start-application",
                {},
                held,
              ),
            ).rejects.toMatchObject({ status: 409 });
            await database
              .update(schema.previews)
              .set({ resources: started.resources })
              .where(eq(schema.previews.id, claim.previewId));
            await acknowledgePreviewDatabaseEffect(
              database,
              claim,
              "start-application",
              {},
              held,
            );
            await updatePreviewProgress(database, claim, { type: "ready" });
            const [ready] = await database.select().from(schema.previews)
              .where(eq(schema.previews.id, claim.previewId));
            const [readyRuntime] = await database.select().from(schema.previewDatabaseRuntime)
              .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
            if (!ready || !readyRuntime) throw new Error("Missing readiness fixture");
            expect(await databasePreviewIsReady(database, ready)).toBe(true);
            await verifyDatabasePreviewAccess(database, ready);
            for (const patch of [
              { imageId: `sha256:${"8".repeat(64)}` },
              { completedEffects: [...readyRuntime.completedEffects].reverse() },
              { completedEffects: readyRuntime.completedEffects.slice(0, 2) },
              { cleanupDeadlineAt: new Date(Date.now() + 10_000) },
              { socket: { ...readyRuntime.socket!, resourceId: crypto.randomUUID() } },
            ]) {
              await database.update(schema.previewDatabaseRuntime).set(patch)
                .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
              expect(await databasePreviewIsReady(database, ready)).toBe(false);
              await database.update(schema.previewDatabaseRuntime).set({
                imageId: readyRuntime.imageId, completedEffects: readyRuntime.completedEffects,
                cleanupDeadlineAt: readyRuntime.cleanupDeadlineAt, socket: readyRuntime.socket,
              }).where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
            }
            expect(await databasePreviewIsReady(database, { ...ready, files: ready.files.filter((file) => file.path !== "wrenly.app.json") })).toBe(false);
            expect(await databasePreviewIsReady(database, { ...ready, files: [...ready.files,
              { path: "tampered.txt", content: "tampered" }] })).toBe(false);
            await database.update(schema.projectMembers).set({ role: "viewer" })
              .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, "db-editor")));
            expect(await databasePreviewIsReady(database, ready)).toBe(false);
            await database.update(schema.projectMembers).set({ role: "editor" })
              .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, "db-editor")));
            expect(await databasePreviewIsReady(database, ready)).toBe(true);

          }
        }
        if (!unknownSocket)
          await expect(
            beginPreviewDatabaseCleanup(
              database,
              claim,
              crypto.randomUUID(),
              held,
            ),
          ).rejects.toMatchObject({ status: 409 });
        expect(await stopPreview(database, claim.previewId, "db-editor")).toBe(
          true,
        );
        if (unknownPreparation) {
          // Revocation and expiry stop app effects but cannot prevent cleanup of exact original targets.
          await database
            .update(schema.projectMembers)
            .set({ role: "viewer" })
            .where(
              and(
                eq(schema.projectMembers.projectId, projectId),
                eq(schema.projectMembers.userId, "db-editor"),
              ),
            );
          await database
            .update(schema.previews)
            .set({ leaseExpiresAt: new Date(Date.now() - 1) })
            .where(eq(schema.previews.id, claim.previewId));
          await expect(
            loadPreviewDatabaseConnection(database, claim, directory, held),
          ).rejects.toMatchObject({ status: 409 });
        }
        const cleanupToken = crypto.randomUUID();
        let cleanup = await beginPreviewDatabaseCleanup(
          database,
          claim,
          cleanupToken,
          held,
        );
        expect(
          await beginPreviewDatabaseCleanup(
            database,
            claim,
            cleanupToken,
            held,
          ),
        ).toEqual(cleanup);
        await expect(
          beginPreviewDatabaseCleanup(
            database,
            claim,
            crypto.randomUUID(),
            held,
          ),
        ).rejects.toMatchObject({ status: 409 });
        await assertPreviewDatabaseCleanup(database, cleanup, held);
        const [beforeRenewal] = await database
          .select()
          .from(schema.previewDatabaseRuntime)
          .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
        await renewPreviewDatabaseCleanup(database, cleanup, held);
        const [afterRenewal] = await database
          .select()
          .from(schema.previewDatabaseRuntime)
          .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
        expect(afterRenewal?.cleanupDeadlineAt).toEqual(
          beforeRenewal?.cleanupDeadlineAt,
        );
        expect(
          afterRenewal!.cleanupLeaseExpiresAt!.getTime(),
        ).toBeLessThanOrEqual(afterRenewal!.cleanupDeadlineAt!.getTime());
        await expect(
          recordPreviewDatabaseEffect(
            database,
            claim,
            "prepare-artifact",
            held,
          ),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
          finishPreviewDatabaseCleanup(database, cleanup, held),
        ).rejects.toMatchObject({ status: 409 });
        if (scenario === "sequence") {
          const calls: string[] = [];
          let failSocket = true;
          let failArtifact = true;
          const adapters: PreviewDatabaseCleanupAdapters = {
            application: async (_identity, fence) => { await fence?.(); calls.push("application"); },
            socket: async (_scope, _id, fence) => {
              await fence?.(); calls.push("socket");
              if (failSocket) throw new Error("Socket response lost");
            },
            sessions: async (input) => {
              await input.fence.assertHeld();
              expect(input.target).toBe("runtime");
              expect(input.credentials).toEqual(credentials);
              calls.push("sessions");
            },
            administratorBundle: async () => new Uint8Array([1]),
            artifact: async (_id, fence) => {
              await fence(); calls.push("artifact");
              if (failArtifact) throw new Error("Artifact removal unconfirmed");
            },
          };
          const run = (signal = new AbortController().signal, kernel = held): Promise<void> =>
            cleanupPreviewDatabaseRuntime(database, cleanup, directory, signal, kernel, adapters);
          await expect(run(AbortSignal.abort())).rejects.toMatchObject({ status: 409 });
          await expect(run(undefined, () => { throw new Error("Lost kernel lock"); })).rejects.toMatchObject({ status: 409 });
          expect(calls).toEqual([]);
          await expect(run()).rejects.toMatchObject({ status: 409 });
          expect(calls).toEqual(["application", "socket"]);
          const [partial] = await database.select().from(schema.previewDatabaseRuntime)
            .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
          expect(partial?.cleanupEffect?.kind).toBe("socket");
          expect(partial?.completedCleanupEffects.map((receipt) => receipt.kind)).toEqual(["application"]);
          expect((await database.select().from(schema.previews)
            .where(eq(schema.previews.id, claim.previewId)))[0]?.cleanupCompletedAt).toBeNull();
          if (!partial) throw new Error("Missing partial cleanup");
          for (const receipts of [
            partial.completedCleanupEffects.map((receipt) => ({ ...receipt, id: "foreign" })),
            [...partial.completedCleanupEffects, ...partial.completedCleanupEffects],
            [{ ...partial.completedCleanupEffects[0]!, kind: "socket" as const }],
          ]) {
            await database.update(schema.previewDatabaseRuntime).set({ completedCleanupEffects: receipts })
              .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
            await expect(run()).rejects.toMatchObject({ status: 409 });
            expect(calls).toEqual(["application", "socket"]);
          }
          await database.update(schema.previewDatabaseRuntime).set({ completedCleanupEffects: partial.completedCleanupEffects })
            .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
          if (!partial.cleanupEffect) throw new Error("Missing pending socket target");
          await database.update(schema.previewDatabaseRuntime).set({
            cleanupEffect: { ...partial.cleanupEffect, id: "foreign-pending-target" },
          }).where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
          await expect(run()).rejects.toMatchObject({ status: 409 });
          expect(calls).toEqual(["application", "socket"]);
          await database.update(schema.previewDatabaseRuntime).set({ cleanupEffect: partial.cleanupEffect })
            .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
          failSocket = false;
          await expect(run()).rejects.toMatchObject({ status: 409 });
          expect(calls).toEqual(["application", "socket", "socket", "sessions", "artifact"]);
          failArtifact = false;
          await run();
          expect(calls).toEqual(["application", "socket", "socket", "sessions", "artifact", "artifact"]);
          await expect(run()).rejects.toMatchObject({ status: 409 });
          expect(calls).toHaveLength(6);
        } else {
        for (const premature of ["socket", "sessions", "artifact"] as const)
          await expect(
            recordPreviewDatabaseCleanup(database, cleanup, premature, held),
          ).rejects.toMatchObject({ status: 409 });
        let prematureSocketCalls = 0;
        await expect(
          cleanupPreviewDatabaseSocket(database, cleanup, held, async () => {
            prematureSocketCalls++;
          }),
        ).rejects.toMatchObject({ status: 409 });
        expect(prematureSocketCalls).toBe(0);
        await recordPreviewDatabaseCleanup(
          database,
          cleanup,
          "application",
          held,
        );
        await expect(
          recordPreviewDatabaseCleanup(database, cleanup, "socket", held),
        ).rejects.toMatchObject({ status: 409 });
        if (unknownPreparation) {
          const old = cleanup;
          await database
            .update(schema.previewDatabaseRuntime)
            .set({ cleanupLeaseExpiresAt: new Date(Date.now() - 1) })
            .where(
              eq(schema.previewDatabaseRuntime.previewId, claim.previewId),
            );
          await expect(
            assertPreviewDatabaseCleanup(database, old, held),
          ).rejects.toMatchObject({ status: 409 });
          await expect(
            renewPreviewDatabaseCleanup(database, old, held),
          ).rejects.toMatchObject({ status: 409 });
          await expect(
            beginPreviewDatabaseCleanup(database, claim, cleanupToken, held),
          ).rejects.toMatchObject({ status: 409 });
          cleanup = await beginPreviewDatabaseCleanup(
            database,
            claim,
            crypto.randomUUID(),
            held,
          );
          await expect(
            acknowledgePreviewDatabaseCleanup(
              database,
              old,
              "application",
              held,
            ),
          ).rejects.toMatchObject({ status: 409 });
          await recordPreviewDatabaseCleanup(
            database,
            cleanup,
            "application",
            held,
          );
        }
        await expect(
          cleanupPreviewDatabaseApplication(database, cleanup, held, async (_identity, fence) => {
            await fence?.();
            throw new Error("PRIVATE_APPLICATION_REMOVAL_UNCONFIRMED");
          }),
        ).rejects.toMatchObject({ status: 409 });
        await cleanupPreviewDatabaseApplication(database, cleanup, held, async (identity, fence) => {
          expect(identity).toEqual({ previewId: claim.previewId, projectId, buildId, claimToken: claim.token });
          await fence?.();
        });
        await expect(
          recordPreviewDatabaseCleanup(database, cleanup, "application", held),
        ).rejects.toMatchObject({ status: 409 });
        for (const kind of ["socket", "sessions", "artifact"] as const) {
          const [ordered] = await database
            .select()
            .from(schema.previewDatabaseRuntime)
            .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
          if (!ordered) throw new Error("Missing cleanup fixture");
          // Correct category names cannot substitute for receipts owned by this preview.
          await database
            .update(schema.previewDatabaseRuntime)
            .set({
              completedCleanupEffects: ordered.completedCleanupEffects.map(
                (receipt) => ({ ...receipt, id: `foreign-${receipt.id}` }),
              ),
            })
            .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
          await expect(
            recordPreviewDatabaseCleanup(database, cleanup, kind, held),
          ).rejects.toMatchObject({ status: 409 });
          await database
            .update(schema.previewDatabaseRuntime)
            .set({ completedCleanupEffects: ordered.completedCleanupEffects })
            .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
          if (kind === "socket") {
            if (unknownPreparation) {
              await expect(
                cleanupPreviewDatabaseSocket(
                  database,
                  cleanup,
                  held,
                  async (_scope, _id, fence) => {
                    await fence?.();
                    throw new Error("PRIVATE_SOCKET_REMOVAL_UNCONFIRMED");
                  },
                ),
              ).rejects.toMatchObject({ status: 409 });
              expect(
                (
                  await database
                    .select()
                    .from(schema.previewDatabaseRuntime)
                    .where(
                      eq(
                        schema.previewDatabaseRuntime.previewId,
                        claim.previewId,
                      ),
                    )
                )[0]?.cleanupEffect?.kind,
              ).toBe("socket");
            }
            await cleanupPreviewDatabaseSocket(
              database,
              cleanup,
              held,
              async (scope, id, fence) => {
                expect(scope).toEqual({
                  projectId,
                  resourceId,
                  environment: "development",
                });
                expect(id).toBe(claim.previewId);
                await fence?.();
              },
            );
            continue;
          }
          if (kind === "sessions") {
            const signal = new AbortController().signal;
            const bundle = async (): Promise<Uint8Array> => new Uint8Array([1]);
            await expect(cleanupPreviewDatabaseSessions(database, cleanup, directory, signal, held,
              async (input) => {
                await input.fence.assertHeld();
                throw new Error("PRIVATE_SESSION_TERMINATION_UNCONFIRMED");
              }, bundle,
            )).rejects.toMatchObject({ status: 409 });
            const [pending] = await database.select().from(schema.previewDatabaseRuntime)
              .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
            expect(pending?.cleanupEffect?.kind).toBe("sessions");
            let invalidCalls = 0;
            await database.update(schema.appDatabases).set({
              secrets: encryptDatabaseSecret(JSON.stringify(credentials), key, `${crypto.randomUUID()}:development`),
            }).where(eq(schema.appDatabases.id, resourceId));
            await expect(cleanupPreviewDatabaseSessions(database, cleanup, directory, signal, held,
              async () => { invalidCalls++; }, bundle,
            )).rejects.toMatchObject({ status: 409 });
            expect(invalidCalls).toBe(0);
            await database.update(schema.appDatabases).set({ secrets }).where(eq(schema.appDatabases.id, resourceId));
            await cleanupPreviewDatabaseSessions(database, cleanup, directory, signal, held,
              async (input) => {
                expect(input.target).toBe("runtime");
                expect(input.scope).toEqual({ projectId, resourceId, environment: "development" });
                expect(input.database).toEqual(identity);
                expect(input.credentials).toEqual(credentials);
                expect(input.operationId).toBe(claim.previewId);
                await input.fence.assertHeld();
                await expect(input.fence.beforeEffect({ kind: "terminate-sessions", id: crypto.randomUUID() })).rejects.toThrow();
                const effect = { kind: "terminate-sessions" as const, id: `wrenly-database-administrator-${claim.previewId}` };
                await input.fence.beforeEffect(effect);
                await input.fence.acknowledgeEffect(effect);
              }, bundle,
            );
            continue;
          }
          await recordPreviewDatabaseCleanup(database, cleanup, kind, held);
          await database
            .update(schema.previewDatabaseRuntime)
            .set({ completedCleanupEffects: [] })
            .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
          await expect(
            acknowledgePreviewDatabaseCleanup(database, cleanup, kind, held),
          ).rejects.toMatchObject({ status: 409 });
          await database
            .update(schema.previewDatabaseRuntime)
            .set({ completedCleanupEffects: ordered.completedCleanupEffects })
            .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
          await expect(cleanupPreviewDatabaseArtifact(database, cleanup, held, async (_id, fence) => {
            await fence();
            throw new Error("PRIVATE_ARTIFACT_REMOVAL_UNCONFIRMED");
          })).rejects.toMatchObject({ status: 409 });
          await cleanupPreviewDatabaseArtifact(database, cleanup, held, async (id, fence) => {
            expect(id).toBe(claim.previewId);
            await fence();
          });
        }
        await finishPreviewDatabaseCleanup(database, cleanup, held);
        }
        const [runtime] = await database
          .select()
          .from(schema.previewDatabaseRuntime)
          .where(eq(schema.previewDatabaseRuntime.previewId, claim.previewId));
        expect(runtime?.effect?.kind ?? null).toBe(
          unknownPreparation
            ? "prepare-artifact"
            : unknownSocket
              ? "create-socket"
              : null,
        );
        expect(runtime?.completedCleanupEffects.length).toBe(4);
        for (const role of [
          credentials.administrator,
          credentials.migrator,
          credentials.runtime,
          credentials.reader,
        ])
          expect(JSON.stringify(runtime)).not.toContain(role.password);
        expect(runtime?.cleanupToken).toBeNull();
        expect(
          (
            await database
              .select()
              .from(schema.previews)
              .where(eq(schema.previews.id, claim.previewId))
          )[0]?.cleanupCompletedAt,
        ).not.toBeNull();
        await expect(
          assertPreviewDatabaseCleanup(database, cleanup, held),
        ).rejects.toMatchObject({ status: 409 });
        expect(
          (
            await database
              .select()
              .from(schema.appDatabases)
              .where(eq(schema.appDatabases.id, resourceId))
          )[0]?.revision,
        ).toBe(resourceRevision);
      } finally {
        await lock.release();
        await database
          .update(schema.projectMembers)
          .set({ role: "editor" })
          .where(
            and(
              eq(schema.projectMembers.projectId, projectId),
              eq(schema.projectMembers.userId, "db-editor"),
            ),
          );
        await database
          .delete(schema.previews)
          .where(eq(schema.previews.id, admitted.previewId));
      }
    }
  } finally {
    key.fill(0);
    await database
      .update(schema.appDatabases)
      .set({
        secrets: original.secrets,
        runtimeIdentity: original.runtimeIdentity,
      })
      .where(eq(schema.appDatabases.id, resourceId));
  }
}
