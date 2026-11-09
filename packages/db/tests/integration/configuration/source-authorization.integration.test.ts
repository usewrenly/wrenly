import {
  saveSourceImportReview,
  admitSourceImport,
} from "../../../../../apps/api/src/modules/source-control/imports/import-store";
import {
  saveSourceGitHubApp,
  readSourceAppForExchange,
  saveSourcePersonalConnection,
  readSourceConnectionStatus,
  readSourcePersonalToken,
  disconnectSourceConnection,
} from "../../../../../apps/api/src/modules/source-control/github/connection-store";
/** Uses only a named disposable local database; no GitHub calls or operator credentials. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/schema";
import {
  beginSourceAuthorization,
  consumeSourceAuthorization,
} from "../../../../../apps/api/src/modules/source-control/github/authorization-store";
import {
  loadSourceCredentialKey,
  encryptSourceCredential,
} from "../../../../../apps/api/src/modules/source-control/github/credentials";
const url = process.env.WRENLY_TEST_SOURCE_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.pathname !== "/wrenly_source_test"
  )
    throw new Error("Use only a disposable local wrenly_source_test database.");
}
const integration = url ? describe : describe.skip;
integration("session-bound GitHub authorization persistence", () => {
  const client = postgres(url ?? "postgresql://localhost/wrenly_source_test", {
    onnotice: () => {},
  });
  const database = drizzle(client, { schema });
  const revision = "11111111-1111-4111-8111-111111111111";
  const owner = { userId: "owner", sessionId: "owner-session", revision };
  const member = { userId: "member", sessionId: "member-session", revision };
  let directory = "";
  beforeAll(async () => {
    await migrate(database, {
      migrationsFolder: `${import.meta.dir}/../../../migrations`,
    });
    directory = await mkdtemp(join(tmpdir(), "wrenly-source-test-"));
  });
  beforeEach(async () => {
    await database.delete(schema.sourceProjectOrigins);
    await database.delete(schema.sourceImportReviews);
    await database.delete(schema.projects);
    await database.delete(schema.sourceAuthorizationRequests);
    await database.delete(schema.sourceConnections);
    await database.delete(schema.sourceGitHubApp);
    await database.delete(schema.instanceSetup);
    await database.delete(schema.session);
    await database.delete(schema.user);
    await database.insert(schema.user).values(
      ["owner", "member"].map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        accessRevision: revision,
      })),
    );
    await database.insert(schema.session).values(
      [owner, member].map((p) => ({
        id: p.sessionId,
        token: `${p.userId}-fixture-token`,
        userId: p.userId,
        accessRevision: revision,
        expiresAt: new Date(Date.now() + 60000),
      })),
    );
    await database
      .insert(schema.instanceSetup)
      .values({ id: 1, ownerId: owner.userId });
  });
  afterAll(async () => {
    await client.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  test("only the owner registers an App, and callback replay is refused", async () => {
    await expect(
      beginSourceAuthorization(
        database,
        member,
        "register-app",
        "http://localhost:3000",
        directory,
      ),
    ).rejects.toThrow("instance owner");
    const pending = await beginSourceAuthorization(
      database,
      owner,
      "register-app",
      "http://localhost:3000",
      directory,
    );
    const [row] = await database
      .select()
      .from(schema.sourceAuthorizationRequests);
    expect(row?.stateHash).not.toBe(pending.state);
    await expect(
      consumeSourceAuthorization(
        database,
        member,
        "register-app",
        pending.state,
        "http://localhost:3000",
        directory,
      ),
    ).rejects.toThrow();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        consumeSourceAuthorization(
          database,
          owner,
          "register-app",
          pending.state,
          "http://localhost:3000",
          directory,
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  test("expired or revoked sessions cannot consume an otherwise valid callback", async () => {
    const pending = await beginSourceAuthorization(
      database,
      owner,
      "register-app",
      "http://localhost:3000",
      directory,
    );
    await database
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, owner.userId));
    await expect(
      consumeSourceAuthorization(
        database,
        owner,
        "register-app",
        pending.state,
        "http://localhost:3000",
        directory,
      ),
    ).rejects.toThrow();
    expect(
      (await database.select().from(schema.sourceAuthorizationRequests))[0]
        ?.consumedAt,
    ).toBeNull();
    await database
      .update(schema.user)
      .set({ banned: false })
      .where(eq(schema.user.id, owner.userId));
    await database
      .update(schema.sourceAuthorizationRequests)
      .set({ expiresAt: new Date(0) });
    await expect(
      consumeSourceAuthorization(
        database,
        owner,
        "register-app",
        pending.state,
        "http://localhost:3000",
        directory,
      ),
    ).rejects.toThrow("expired");
  });
  test("personal authorization encrypts its verifier and pins the App version", async () => {
    const version = crypto.randomUUID(),
      key = await loadSourceCredentialKey(directory, false);
    const credential = encryptSourceCredential(
      { clientSecret: "fixture-secret", privateKey: "fixture-key" },
      key,
      { kind: "app", id: version, userId: owner.userId },
    );
    await database.insert(schema.sourceGitHubApp).values({
      id: 1,
      version,
      appId: "42",
      slug: "fixture",
      clientId: "Iv1.fixture",
      credential,
      configuredBy: owner.userId,
    });
    const pending = await beginSourceAuthorization(
      database,
      member,
      "connect-account",
      "http://localhost:3000",
      directory,
    );
    const [stored] = await database
      .select()
      .from(schema.sourceAuthorizationRequests);
    const claim = await consumeSourceAuthorization(
      database,
      member,
      "connect-account",
      pending.state,
      "http://localhost:3000",
      directory,
    );
    expect(claim.appVersion).toBe(version);
    expect(claim.verifier).toHaveLength(43);
    expect(JSON.stringify(stored)).not.toContain(claim.verifier!);
    const stale = await beginSourceAuthorization(
      database,
      member,
      "connect-account",
      "http://localhost:3000",
      directory,
    );
    await database
      .update(schema.sourceGitHubApp)
      .set({ version: crypto.randomUUID() });
    await expect(
      consumeSourceAuthorization(
        database,
        member,
        "connect-account",
        stale.state,
        "http://localhost:3000",
        directory,
      ),
    ).rejects.toThrow("expired");
  });
  test("completion stores only encrypted personal credentials and disconnect fences pending callbacks", async () => {
    const registration = await beginSourceAuthorization(
      database,
      owner,
      "register-app",
      "http://localhost:3000",
      directory,
    );
    const appClaim = await consumeSourceAuthorization(
      database,
      owner,
      "register-app",
      registration.state,
      "http://localhost:3000",
      directory,
    );
    await saveSourceGitHubApp(
      database,
      owner,
      appClaim.id,
      {
        id: 42,
        slug: "fixture",
        client_id: "Iv1.fixture",
        client_secret: "app-secret",
        pem: "fixture-key",
        permissions: { contents: "write", metadata: "read" },
      },
      directory,
    );
    const pending = await beginSourceAuthorization(
      database,
      member,
      "connect-account",
      "http://localhost:3000",
      directory,
    );
    const claim = await consumeSourceAuthorization(
      database,
      member,
      "connect-account",
      pending.state,
      "http://localhost:3000",
      directory,
    );
    expect(
      (await readSourceAppForExchange(database, member, claim.id, directory))
        .clientId,
    ).toBe("Iv1.fixture");
    await saveSourcePersonalConnection(
      database,
      member,
      claim.id,
      {
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        token_type: "bearer",
        expires_in: 28800,
        refresh_token_expires_in: 15552000,
      },
      { id: 73, login: "member-github" },
      directory,
    );
    const status = await readSourceConnectionStatus(database, member);
    expect(status.connection?.login).toBe("member-github");
    expect(JSON.stringify(status)).not.toContain("credential");
    expect(
      (await readSourceConnectionStatus(database, owner)).connection,
    ).toBeNull();
    expect(
      (await readSourcePersonalToken(database, member, directory)).token,
    ).toBe("access-secret");
    expect(
      JSON.stringify(await database.select().from(schema.sourceConnections)),
    ).not.toContain("access-secret");
    const later = await beginSourceAuthorization(
      database,
      member,
      "connect-account",
      "http://localhost:3000",
      directory,
    );
    await disconnectSourceConnection(
      database,
      member,
      status.connection!.version,
    );
    expect(
      (await readSourceConnectionStatus(database, member)).connection,
    ).toBeNull();
    await expect(
      readSourcePersonalToken(database, member, directory),
    ).rejects.toThrow("Authorize");
    await expect(
      consumeSourceAuthorization(
        database,
        member,
        "connect-account",
        later.state,
        "http://localhost:3000",
        directory,
      ),
    ).rejects.toThrow();
    await expect(
      readSourceAppForExchange(database, member, claim.id, directory),
    ).rejects.toThrow();
  });

  test("import confirmation is private, atomic and replayable without generating different source", async () => {
    const connectionVersion = crypto.randomUUID();
    const appVersion = crypto.randomUUID();
    await database
      .insert(schema.sourceGitHubApp)
      .values({
        id: 1,
        version: appVersion,
        appId: "42",
        slug: "fixture",
        clientId: "fixture",
        credential: {},
        configuredBy: owner.userId,
      });
    await database.insert(schema.sourceConnections).values({
      userId: owner.userId,
      provider: "github",
      version: connectionVersion,
      appVersion,
      remoteUserId: "73",
      remoteLogin: "fixture",
      credential: {},
      accessExpiresAt: new Date(Date.now() + 60000),
      refreshExpiresAt: new Date(Date.now() + 60000),
    });
    const snapshot = {
      repository: {
        provider: "github" as const,
        id: "12",
        owner: "studio",
        name: "notes",
        private: true,
      },
      commitId: "a".repeat(40),
      treeId: "b".repeat(40),
      files: [
        {
          path: "package.json",
          content: '{"dependencies":{"next":"15.5.28"}}',
        },
      ],
      excludedPaths: [".env"],
    };
    const review = await saveSourceImportReview(
      database,
      owner,
      connectionVersion,
      snapshot,
      "nextjs",
    );
    const command = {
      requestId: crypto.randomUUID(),
      reviewId: review.reviewId,
      name: "Imported notes",
    };
    await expect(admitSourceImport(database, member, command)).rejects.toThrow(
      "review",
    );
    const results = await Promise.all([
      admitSourceImport(database, owner, command),
      admitSourceImport(database, owner, command),
    ]);
    expect(results[0]!.projectId).toBe(results[1]!.projectId);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    const [project] = await database.select().from(schema.projects);
    expect(project?.userId).toBe(owner.userId);
    expect(project?.accessMode).toBe("private");
    const [job] = await database.select().from(schema.buildJobs);
    expect(job?.input.previousFiles).toEqual(snapshot.files);
    expect(job?.input.sourceValidationV1?.commitId).toBe(snapshot.commitId);
    await expect(
      admitSourceImport(database, owner, { ...command, name: "Another" }),
    ).rejects.toThrow("request ID");
    await expect(
      admitSourceImport(database, owner, {
        ...command,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("already created");
    const later = await saveSourceImportReview(
      database,
      owner,
      connectionVersion,
      snapshot,
      "nextjs",
    );
    await database
      .update(schema.sourceConnections)
      .set({ disconnectedAt: new Date() });
    await expect(
      admitSourceImport(database, owner, {
        ...command,
        requestId: crypto.randomUUID(),
        reviewId: later.reviewId,
      }),
    ).rejects.toThrow("connection changed");
    expect(await database.select().from(schema.projects)).toHaveLength(1);
  });
});
