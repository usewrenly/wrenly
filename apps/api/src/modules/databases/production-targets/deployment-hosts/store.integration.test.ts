/** Opt-in acceptance against a dedicated disposable control database, never an existing instance. */
import { hasMemberDatabaseWork } from "../../database-activity";
import { beforeAll, beforeEach, afterAll, expect, test } from "bun:test";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as schema from "@wrenly/db/schema";
import {
  admitRuntimeHostConnection,
  readRuntimeHostConnection,
  claimRuntimeHostConnection,
  loadRuntimeHostConnection,
  finishRuntimeHostConnection,
  acknowledgeRuntimeHostCheck,
} from "./store";
const url = process.env.WRENLY_TEST_RUNTIME_HOST_URL;
if (url) {
  const value = new URL(url);
  if (
    value.hostname !== "127.0.0.1" ||
    value.pathname !== "/wrenly_runtime_host_test"
  )
    throw new Error(
      "Use the dedicated disposable instance connection database",
    );
}
const client = postgres(
  url ?? "postgresql://unused:unused@127.0.0.1:1/unused",
  { max: 1 },
);
const database = drizzle(client, { schema });
const check = url ? test : test.skip;
const principal = {
  userId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  revision: crypto.randomUUID(),
};
const other = {
  userId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  revision: crypto.randomUUID(),
};
let directory = "";
const target = {
  host: "deploy.internal.test",
  port: 22,
  user: "wrenly",
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + "A".repeat(43),
};
function input(expectedConnectionId: string | null = null) {
  return {
    requestId: crypto.randomUUID(),
    expectedConnectionId,
    confirmTarget: true as const,
    target,
    serverId: "coolify-fixture",
    privateKey:
      "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only\n-----END OPENSSH PRIVATE KEY-----\n",
  };
}
const verification = {
  status: "verified" as const,
  inspection: {
    version: 1 as const,
    nonce: crypto.randomUUID(),
    dockerId: "fixture-daemon",
    operatingSystem: "linux" as const,
    architecture: "x86_64" as const,
    helperVersion: 1 as const,
  },
  pinned: { target, addresses: ["10.20.30.40"] },
};
beforeAll(async () => {
  if (!url) return;
  directory = await mkdtemp(join(tmpdir(), "wrenly-instance-connection-"));
  await migrate(database, {
    migrationsFolder: resolve(
      import.meta.dir,
      "../../../../../../../packages/db/migrations",
    ),
  });
  for (const actor of [principal, other]) {
    await database.insert(schema.user).values({
      id: actor.userId,
      email: `${actor.userId}@example.test`,
      name: "Fixture user",
      accessRevision: actor.revision,
    });
    await database.insert(schema.session).values({
      id: actor.sessionId,
      userId: actor.userId,
      token: crypto.randomUUID(),
      accessRevision: actor.revision,
      expiresAt: new Date(Date.now() + 600_000),
    });
  }
  await database
    .insert(schema.instanceSetup)
    .values({ id: 1, ownerId: principal.userId })
    .onConflictDoUpdate({
      target: schema.instanceSetup.id,
      set: { ownerId: principal.userId },
    });
});
beforeEach(async () => {
  if (url) await database.delete(schema.productionRuntimeHosts);
});
afterAll(async () => {
  await client.end({ timeout: 1 });
  if (directory) await rm(directory, { recursive: true, force: true });
});
check(
  "one instance connection is independent of projects, encrypted and exact-replay protected",
  async () => {
    const request = input();
    const first = await admitRuntimeHostConnection(
      database,
      principal,
      request,
      directory,
    );
    expect(
      (
        await admitRuntimeHostConnection(
          database,
          principal,
          request,
          directory,
        )
      ).connectionId,
    ).toBe(first.connectionId);
    await expect(
      admitRuntimeHostConnection(
        database,
        principal,
        {
          ...request,
          privateKey: request.privateKey.replace("fixture-only", "changed"),
        },
        directory,
      ),
    ).rejects.toThrow();
    const [saved] = await database.select().from(schema.productionRuntimeHosts);
    expect(JSON.stringify(saved)).not.toContain(request.privateKey);
    expect(await database.select().from(schema.projects)).toHaveLength(0);
    const status = await readRuntimeHostConnection(database, principal);
    expect(Object.keys(status ?? {}).sort()).toEqual([
      "connectionId",
      "serverId",
      "status",
      "target",
      "verified",
    ]);
    expect(JSON.stringify(status)).not.toContain("credential");
    expect(
      (await readRuntimeHostConnection(database, principal, request.requestId))
        ?.connectionId,
    ).toBe(first.connectionId);
    expect(
      await readRuntimeHostConnection(database, principal, crypto.randomUUID()),
    ).toBeNull();
    const claim = await claimRuntimeHostConnection(database);
    if (!claim) throw new Error("Missing claim");
    expect(
      (await loadRuntimeHostConnection(database, claim, directory)).privateKey,
    ).toEqual(request.privateKey);
    await finishRuntimeHostConnection(database, claim, verification);
    expect((await readRuntimeHostConnection(database, principal))?.status).toBe(
      "verified",
    );
    expect(await database.select().from(schema.appDatabases)).toHaveLength(0);
  },
);
check(
  "members and stale sessions cannot read, admit or decrypt instance setup",
  async () => {
    await expect(
      admitRuntimeHostConnection(database, other, input(), directory),
    ).rejects.toThrow();
    await expect(readRuntimeHostConnection(database, other)).rejects.toThrow();
    await admitRuntimeHostConnection(database, principal, input(), directory);
    const claim = await claimRuntimeHostConnection(database);
    if (!claim) throw new Error("Missing claim");
    await expect(
      loadRuntimeHostConnection(
        database,
        { ...claim, token: crypto.randomUUID() },
        directory,
      ),
    ).rejects.toThrow();
    await database
      .update(schema.session)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.session.id, principal.sessionId));
    try {
      await expect(
        loadRuntimeHostConnection(database, claim, directory),
      ).rejects.toThrow();
      await expect(
        finishRuntimeHostConnection(database, claim, verification),
      ).rejects.toThrow();
    } finally {
      await database
        .update(schema.session)
        .set({ expiresAt: new Date(Date.now() + 600_000) })
        .where(eq(schema.session.id, principal.sessionId));
    }
  },
);
check(
  "expired checks require explicit closure and cannot complete from their old claim",
  async () => {
    const first = await admitRuntimeHostConnection(
      database,
      principal,
      input(),
      directory,
    );
    const claim = await claimRuntimeHostConnection(database);
    if (!claim) throw new Error("Missing claim");
    await expect(
      acknowledgeRuntimeHostCheck(database, principal, first.connectionId),
    ).rejects.toThrow();
    await database
      .update(schema.productionRuntimeHosts)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.productionRuntimeHosts.id, first.connectionId));
    expect(await claimRuntimeHostConnection(database)).toBeNull();
    expect((await readRuntimeHostConnection(database, principal))?.status).toBe(
      "needs_review",
    );
    await expect(
      finishRuntimeHostConnection(database, claim, verification),
    ).rejects.toThrow();
    await acknowledgeRuntimeHostCheck(database, principal, first.connectionId);
    expect(
      (
        await acknowledgeRuntimeHostCheck(
          database,
          principal,
          first.connectionId,
        )
      ).replayed,
    ).toBe(true);
    const next = await admitRuntimeHostConnection(
      database,
      principal,
      input(first.connectionId),
      directory,
    );
    expect(next.connectionId).not.toBe(first.connectionId);
  },
);
check(
  "new connection revisions preserve old encrypted facts and reject stale expectations",
  async () => {
    const first = await admitRuntimeHostConnection(
      database,
      principal,
      input(),
      directory,
    );
    const claim = await claimRuntimeHostConnection(database);
    if (!claim) throw new Error("Missing claim");
    await finishRuntimeHostConnection(database, claim, verification);
    const [before] = await database
      .select()
      .from(schema.productionRuntimeHosts)
      .where(eq(schema.productionRuntimeHosts.id, first.connectionId));
    const next = await admitRuntimeHostConnection(
      database,
      principal,
      input(first.connectionId),
      directory,
    );
    await expect(
      admitRuntimeHostConnection(
        database,
        principal,
        input(first.connectionId),
        directory,
      ),
    ).rejects.toThrow();
    const [after] = await database
      .select()
      .from(schema.productionRuntimeHosts)
      .where(eq(schema.productionRuntimeHosts.id, first.connectionId));
    expect(after).toEqual(before);
    expect(next.connectionId).not.toBe(first.connectionId);
  },
);
check(
  "mismatched verified targets cannot be acknowledged as successful",
  async () => {
    await admitRuntimeHostConnection(database, principal, input(), directory);
    const claim = await claimRuntimeHostConnection(database);
    if (!claim) throw new Error("Missing claim");
    await expect(
      finishRuntimeHostConnection(database, claim, {
        ...verification,
        pinned: {
          ...verification.pinned,
          target: { ...target, host: "other.internal.test" },
        },
      }),
    ).rejects.toThrow();
    expect((await readRuntimeHostConnection(database, principal))?.status).toBe(
      "checking",
    );
  },
);

check(
  "queued and uncertain instance checks fence account work until explicitly settled",
  async () => {
    const saved = await admitRuntimeHostConnection(
      database,
      principal,
      input(),
      directory,
    );
    expect(await hasMemberDatabaseWork(database, principal.userId)).toBe(true);
    expect(await hasMemberDatabaseWork(database, other.userId)).toBe(false);
    const claim = await claimRuntimeHostConnection(database);
    if (!claim) throw new Error("Missing claim");
    await finishRuntimeHostConnection(database, claim, {
      status: "interrupted",
    });
    expect(await hasMemberDatabaseWork(database, principal.userId)).toBe(true);
    await acknowledgeRuntimeHostCheck(database, principal, saved.connectionId);
    expect(await hasMemberDatabaseWork(database, principal.userId)).toBe(false);
  },
);

check(
  "all active publishing phases fence deployment-host replacement",
  async () => {
    const projectId = crypto.randomUUID(),
      buildId = crypto.randomUUID(),
      deploymentId = crypto.randomUUID();
    await database
      .insert(schema.projects)
      .values({
        id: projectId,
        userId: principal.userId,
        name: "Host fence fixture",
      });
    try {
      await database
        .insert(schema.builds)
        .values({
          id: buildId,
          projectId,
          prompt: "fixture",
          status: "success",
        });
      await database
        .insert(schema.deploymentResources)
        .values({
          projectId,
          gitInstanceUrl: "https://git.internal.test",
          repositoryOwner: "fixture",
          repositoryName: "fixture",
          coolifyInstanceUrl: "https://coolify.internal.test",
          coolifyProjectUuid: "fixture",
          coolifyServerUuid: "fixture",
          coolifyEnvironmentName: "production",
        });
      await database
        .insert(schema.deployments)
        .values({
          id: deploymentId,
          projectId,
          buildId,
          userId: principal.userId,
          idempotencyKey: crypto.randomUUID(),
          requestIdentity: "fixture",
          stack: "nextjs",
          files: [],
          sourceSha256: "a".repeat(64),
        });
      for (const status of [
        "queued",
        "preparing",
        "deploying",
        "verifying",
        "interrupted",
      ] as const) {
        await database
          .update(schema.deployments)
          .set({ status })
          .where(eq(schema.deployments.id, deploymentId));
        await expect(
          admitRuntimeHostConnection(database, principal, input(), directory),
        ).rejects.toThrow("Finish or review");
      }
      expect(
        await database.select().from(schema.productionRuntimeHosts),
      ).toHaveLength(0);
    } finally {
      await database
        .delete(schema.deployments)
        .where(eq(schema.deployments.id, deploymentId));
      await database
        .delete(schema.deploymentResources)
        .where(eq(schema.deploymentResources.projectId, projectId));
      await database.delete(schema.builds).where(eq(schema.builds.id, buildId));
      await database
        .delete(schema.projects)
        .where(eq(schema.projects.id, projectId));
    }
  },
);
