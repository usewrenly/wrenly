import {
  createSourcePushReview,
  admitSourcePush,
  claimSourcePush,
  bindSourceRepository,
} from "../../../../../apps/api/src/modules/source-control/pushes/push-store";
import { executeSourcePush } from "../../../../../apps/api/src/modules/source-control/pushes/push-worker";
import { reconcileSourcePush } from "../../../../../apps/api/src/modules/source-control/pushes/push-recovery";
import { refreshSourceAccessIfNeeded } from "../../../../../apps/api/src/modules/source-control/github/refresh";
import {
  GitHubRequestError,
  type GitHubObjectClient,
} from "@wrenly/source-control";
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
    await database.delete(schema.sourcePushOperations);
    await database.delete(schema.sourcePushReviews);
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
    await database.insert(schema.sourceGitHubApp).values({
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

  async function pushFixture() {
    const appVersion = crypto.randomUUID(),
      connectionVersion = crypto.randomUUID();
    await database.insert(schema.sourceGitHubApp).values({
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
      accessExpiresAt: new Date(Date.now() + 3600000),
      refreshExpiresAt: new Date(Date.now() + 3600000),
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
      excludedPaths: [],
    };
    const review = await saveSourceImportReview(
      database,
      owner,
      connectionVersion,
      snapshot,
      "nextjs",
    );
    const imported = await admitSourceImport(database, owner, {
      requestId: crypto.randomUUID(),
      reviewId: review.reviewId,
      name: "Notes",
    });
    await database
      .update(schema.builds)
      .set({
        status: "success",
        files: [
          ...snapshot.files,
          {
            path: "app/page.tsx",
            content: "export default function Page() { return <p>Notes</p> }",
          },
        ],
      })
      .where(eq(schema.builds.id, imported.buildId));
    await database
      .update(schema.buildJobs)
      .set({ status: "success" })
      .where(eq(schema.buildJobs.buildId, imported.buildId));
    const [project] = await database
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, imported.projectId));
    const input = {
      projectId: imported.projectId,
      buildId: imported.buildId,
      expectedRevision: project!.accessRevision,
      branch: "wrenly/notes-update",
    };
    const prepared = (await createSourcePushReview(
      database,
      owner,
      connectionVersion,
      input,
    )) as { reviewId: string };
    return { imported, input, prepared, snapshot, connectionVersion };
  }
  function remoteFixture(loseRefReply = false) {
    const posts: Array<{ path: string; body: unknown }> = [];
    let published = false;
    const commit = {
      sha: "e".repeat(40),
      tree: { sha: "d".repeat(40) },
      parents: [{ sha: "a".repeat(40) }],
    };
    const client: GitHubObjectClient = {
      async get(path) {
        if (path === "/repositories/12")
          return {
            id: 12,
            owner: { login: "studio" },
            name: "notes",
            private: true,
            archived: false,
            disabled: false,
          };
        if (path.includes("/git/ref/")) {
          if (!published) throw new GitHubRequestError("http_error", 404);
          return {
            ref: "refs/heads/wrenly/notes-update",
            object: { type: "commit", sha: commit.sha },
          };
        }
        if (path.endsWith("/git/commits/" + "a".repeat(40)))
          return { sha: "a".repeat(40), tree: { sha: "b".repeat(40) } };
        if (path.endsWith("?recursive=1"))
          return {
            sha: "b".repeat(40),
            truncated: false,
            tree: [
              {
                path: "package.json",
                mode: "100644",
                type: "blob",
                sha: "c".repeat(40),
                size: 40,
              },
            ],
          };
        if (path.endsWith("/git/commits/" + commit.sha)) return commit;
        throw new Error("Unexpected source read");
      },
      async post(path, body) {
        posts.push({ path, body });
        if (path.endsWith("/git/trees")) return { sha: "d".repeat(40) };
        if (path.endsWith("/git/commits")) return commit;
        if (path.endsWith("/git/refs")) {
          published = true;
          if (loseRefReply) throw new GitHubRequestError("request_failed");
          return {
            ref: "refs/heads/wrenly/notes-update",
            object: { sha: commit.sha },
          };
        }
        throw new Error("Unexpected source write");
      },
    };
    return { client, posts };
  }
  test("push confirmation replays exactly once and creates only a new reviewed branch", async () => {
    const f = await pushFixture();
    await expect(
      createSourcePushReview(database, member, f.connectionVersion, f.input),
    ).rejects.toThrow();
    const command = {
      requestId: crypto.randomUUID(),
      reviewId: f.prepared.reviewId,
    };
    const accepted = await Promise.all([
      admitSourcePush(database, owner, command),
      admitSourcePush(database, owner, command),
    ]);
    expect(accepted[0]!.operationId).toBe(accepted[1]!.operationId);
    expect(accepted.filter((item) => item.replayed)).toHaveLength(1);
    const claim = await claimSourcePush(database);
    expect(claim).not.toBeNull();
    const remote = remoteFixture();
    await executeSourcePush(
      database,
      claim!,
      remote.client,
      new AbortController().signal,
    );
    const [operation] = await database
      .select()
      .from(schema.sourcePushOperations);
    expect(operation?.status).toBe("success");
    expect(remote.posts.map((post) => post.path.split("/").at(-1))).toEqual([
      "trees",
      "commits",
      "refs",
    ]);
    expect(remote.posts[0]?.body).toEqual({
      base_tree: f.snapshot.treeId,
      tree: [
        {
          path: "app/page.tsx",
          mode: "100644",
          type: "blob",
          content: "export default function Page() { return <p>Notes</p> }",
        },
      ],
    });
    expect(remote.posts[2]?.body).toEqual({
      ref: "refs/heads/wrenly/notes-update",
      sha: "e".repeat(40),
    });
    expect(await claimSourcePush(database)).toBeNull();
  });
  test("lost branch acknowledgement requires read-only recovery and never repeats a POST", async () => {
    const f = await pushFixture();
    const operation = await admitSourcePush(database, owner, {
      requestId: crypto.randomUUID(),
      reviewId: f.prepared.reviewId,
    });
    const claim = await claimSourcePush(database);
    const remote = remoteFixture(true);
    await executeSourcePush(
      database,
      claim!,
      remote.client,
      new AbortController().signal,
    );
    const [saved] = await database.select().from(schema.sourcePushOperations);
    expect(saved?.status).toBe("needs_review");
    expect(saved?.phase).toBe("ref");
    expect(await claimSourcePush(database)).toBeNull();
    const result = await reconcileSourcePush(
      database,
      owner,
      { operationId: operation.operationId, confirmRemoteSettled: true },
      new AbortController().signal,
      directory,
      remote.client,
    );
    expect(result.status).toBe("success");
    expect(remote.posts).toHaveLength(3);
  });
  test("access changes after admission stop the worker before any remote mutation", async () => {
    const f = await pushFixture();
    await admitSourcePush(database, owner, {
      requestId: crypto.randomUUID(),
      reviewId: f.prepared.reviewId,
    });
    const claim = await claimSourcePush(database);
    await database
      .update(schema.projects)
      .set({ accessRevision: crypto.randomUUID() })
      .where(eq(schema.projects.id, f.imported.projectId));
    const remote = remoteFixture();
    await executeSourcePush(
      database,
      claim!,
      remote.client,
      new AbortController().signal,
    );
    expect(remote.posts).toHaveLength(0);
    const [saved] = await database.select().from(schema.sourcePushOperations);
    expect(saved?.status).toBe("needs_review");
  });
  test("an unknown single-use refresh is fenced rather than exchanged twice", async () => {
    const appVersion = crypto.randomUUID(),
      connectionVersion = crypto.randomUUID();
    const key = await loadSourceCredentialKey(directory, false);
    await database.insert(schema.sourceGitHubApp).values({
      id: 1,
      version: appVersion,
      appId: "42",
      slug: "fixture",
      clientId: "fixture",
      credential: encryptSourceCredential(
        { clientSecret: "secret", privateKey: "fixture" },
        key,
        { kind: "app", id: appVersion, userId: owner.userId },
      ),
      configuredBy: owner.userId,
    });
    await database.insert(schema.sourceConnections).values({
      userId: owner.userId,
      provider: "github",
      version: connectionVersion,
      appVersion,
      remoteUserId: "73",
      remoteLogin: "fixture",
      credential: encryptSourceCredential(
        { accessToken: "old-access", refreshToken: "once-only" },
        key,
        { kind: "user", id: connectionVersion, userId: owner.userId },
      ),
      accessExpiresAt: new Date(Date.now() + 1000),
      refreshExpiresAt: new Date(Date.now() + 3600000),
    });
    let exchanges = 0;
    await expect(
      refreshSourceAccessIfNeeded(database, owner, directory, async () => {
        exchanges++;
        throw new Error("Lost reply");
      }),
    ).rejects.toThrow("Reconnect");
    await expect(
      refreshSourceAccessIfNeeded(database, owner, directory, async () => {
        exchanges++;
        throw new Error("Must not run");
      }),
    ).rejects.toThrow("earlier token refresh");
    expect(exchanges).toBe(1);
  });

  test("successful refresh preserves connection identity and prevents redundant exchanges", async () => {
    const appVersion = crypto.randomUUID(),
      connectionVersion = crypto.randomUUID();
    const key = await loadSourceCredentialKey(directory, false);
    await database
      .insert(schema.sourceGitHubApp)
      .values({
        id: 1,
        version: appVersion,
        appId: "42",
        slug: "fixture",
        clientId: "fixture",
        credential: encryptSourceCredential(
          { clientSecret: "secret", privateKey: "fixture" },
          key,
          { kind: "app", id: appVersion, userId: owner.userId },
        ),
        configuredBy: owner.userId,
      });
    await database
      .insert(schema.sourceConnections)
      .values({
        userId: owner.userId,
        provider: "github",
        version: connectionVersion,
        appVersion,
        remoteUserId: "73",
        remoteLogin: "fixture",
        credential: encryptSourceCredential(
          { accessToken: "old-access", refreshToken: "once-only" },
          key,
          { kind: "user", id: connectionVersion, userId: owner.userId },
        ),
        accessExpiresAt: new Date(Date.now() + 1000),
        refreshExpiresAt: new Date(Date.now() + 3600000),
      });
    let exchanges = 0;
    await refreshSourceAccessIfNeeded(database, owner, directory, async () => {
      exchanges++;
      return {
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "bearer",
        expires_in: 28800,
        refresh_token_expires_in: 15552000,
      };
    });
    await refreshSourceAccessIfNeeded(database, owner, directory, async () => {
      exchanges++;
      throw new Error("Must not run");
    });
    expect(exchanges).toBe(1);
    const personal = await readSourcePersonalToken(database, owner, directory);
    expect(personal.version).toBe(connectionVersion);
    expect(personal.token).toBe("new-access");
    expect(
      JSON.stringify(await database.select().from(schema.sourceConnections)),
    ).not.toContain("new-refresh");
  });
  test("connecting existing project source preserves its local revision and replays binding acknowledgement", async () => {
    const f = await pushFixture();
    const projectId = crypto.randomUUID(),
      buildId = crypto.randomUUID();
    const original = [
      { path: "package.json", content: '{"dependencies":{"next":"15.5.28"}}' },
      { path: "app/page.tsx", content: "export default 1" },
    ];
    await database
      .insert(schema.projects)
      .values({
        id: projectId,
        userId: owner.userId,
        name: "Existing app",
        stack: "nextjs",
      });
    await database
      .insert(schema.builds)
      .values({
        id: buildId,
        projectId,
        prompt: "Original",
        status: "success",
        files: original,
      });
    const [project] = await database
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    const review = await saveSourceImportReview(
      database,
      owner,
      f.connectionVersion,
      f.snapshot,
      "nextjs",
    );
    const command = {
      projectId,
      buildId,
      expectedRevision: project!.accessRevision,
      reviewId: review.reviewId,
      requestId: crypto.randomUUID(),
    };
    expect(await bindSourceRepository(database, owner, command)).toEqual({
      bound: true,
      replayed: false,
    });
    expect(await bindSourceRepository(database, owner, command)).toEqual({
      bound: true,
      replayed: true,
    });
    const [build] = await database
      .select()
      .from(schema.builds)
      .where(eq(schema.builds.id, buildId));
    expect(build?.files).toEqual(original);
    await expect(
      bindSourceRepository(database, member, command),
    ).rejects.toThrow();
  });
});
