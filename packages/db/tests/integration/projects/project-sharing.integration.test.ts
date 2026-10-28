import { changeMemberAccess } from "../../../../../apps/api/src/modules/auth/members/member-access-store";
import { createProjectSettingsHandlers } from "../../../../../apps/api/src/modules/projects/settings/settings-http";
import {
  readProjectSettings,
  saveProjectSettings,
} from "../../../../../apps/api/src/modules/projects/settings/project-settings";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createConversationHttpHandlers } from "../../../../../apps/api/src/modules/conversations/http/http";
import { createBuildHttpHandlers } from "../../../../../apps/api/src/modules/builds/http/http";
import { createPreviewHttpHandlers } from "../../../../../apps/api/src/modules/previews/http/http";
// Exercises native sessions, Hono and project sharing against disposable PostgreSQL only.
import { beforeAll, afterAll, describe, test, expect } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/schema";
import { createOwnerAccount } from "../../../../../apps/api/src/modules/auth/setup/owner-account";
import { createInvitationAuth } from "../../../../../apps/api/src/modules/auth/invitations/invitation-auth";
import { readActivePrincipal } from "../../../../../apps/api/src/modules/auth/access/access-policy";
import { accessContext } from "../../../../../apps/api/src/modules/auth/access/access-context";
import { createSharingHandlers } from "../../../../../apps/api/src/modules/projects/sharing/sharing-http";
import { createApp } from "../../../../../apps/api/src/app";
import { getProject } from "../../../../../apps/api/src/modules/projects/http/project";
import { listProjects } from "../../../../../apps/api/src/modules/projects/http/projects";
import { admitBuild } from "../../../../../apps/api/src/modules/builds/admission/build-admission";
import {
  getOwnedBuild,
  getOwnedBuildEvents,
} from "../../../../../apps/api/src/modules/builds/persistence/build-queries";
import { requestBuildCancellation } from "../../../../../apps/api/src/modules/builds/persistence/build-job-store";
import {
  admitConversationTurn,
  getConversationHistory,
  cancelConversationTurn,
  getConversationTurnSnapshot,
  claimConversationTurn,
} from "../../../../../apps/api/src/modules/conversations/persistence/conversation-store";
import { admitConversationBuildAction } from "../../../../../apps/api/src/modules/conversations/execution/conversation-actions";
import {
  admitPreview,
  getOwnedPreview,
  stopPreview,
  touchPreviewViewer,
} from "../../../../../apps/api/src/modules/previews/persistence/preview-store";
import {
  issuePreviewGrant,
  consumePreviewGrant,
  authorizePreviewSession,
} from "../../../../../apps/api/src/modules/previews/access/preview-access";
import {
  admitDeployment,
  getLatestOwnedDeployment,
  getOwnedDeployment,
} from "../../../../../apps/api/src/modules/deployments/persistence/deployment-store";
const url = process.env.WRENLY_TEST_SHARING_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    parsed.pathname !== "/wrenly_sharing_test"
  )
    throw new Error("Use only disposable local wrenly_sharing_test.");
}
const integration = url ? describe : describe.skip;
integration("native authenticated project collaboration", () => {
  const connection = postgres(
      url ?? "postgresql://localhost/wrenly_sharing_test",
      { onnotice: () => {} },
    ),
    db = drizzle(connection, { schema });
  const config = {
    secret: "fixture-auth-secret-for-project-sharing-0123456789",
    apiUrl: "http://localhost:3002",
    webUrl: "http://localhost:3000",
  };
  const people = new Map<
    string,
    { id: string; cookie: string; sessionId: string }
  >();
  let projectId = "",
    providerId = "";
  const session = async (headers: Headers): Promise<string | null> => {
    const value = await db.transaction((tx) =>
      createInvitationAuth(tx, config).api.getSession({ headers }),
    );
    if (!value) return null;
    const principal = await readActivePrincipal(
      db,
      value.user.id,
      value.session.id,
    );
    if (!principal) return null;
    const context = accessContext.getStore();
    if (context) context.principal = principal;
    return principal.userId;
  };
  const ok = async (): Promise<Response> => Response.json({ ok: true });
  const app = createApp(
    {
      sharing: createSharingHandlers(db, session, config.webUrl),
      projectSettings: createProjectSettingsHandlers({
        webUrl: config.webUrl,
        userId: session,
        read: (actor, id) => readProjectSettings(db, actor, id),
        save: (actor, id, input) => saveProjectSettings(db, actor, id, input),
      }),
      listProjects: (request) =>
        listProjects(request, { database: db, session }),
      getProject: (request, id) =>
        getProject(request, id, { database: db, session }),
      createProject: ok,
      deployProject: ok,
      getModels: async () => {
        const [provider] = await db
          .select()
          .from(schema.providerConnections)
          .where(eq(schema.providerConnections.id, providerId));
        const id = provider
          ? `saved:${provider.id}:${provider.version}`
          : "fixture";
        return Response.json({
          providers: [
            {
              id,
              label: "Local fixture",
              kind: "local",
              reachable: true,
              displayUrl: "Local fixture",
              hint: null,
            },
          ],
          models: [
            {
              id: "fixture-model",
              label: "Fixture model",
              provider: id,
              kind: "local",
            },
          ],
          envDefault: "fixture-model",
          defaultProvider: id,
        });
      },
      generate: ok,
      auth: async (request) => {
        if (!new URL(request.url).pathname.endsWith("/get-session"))
          return Response.json({ error: "Closed" }, { status: 403 });
        return Response.json(
          await db.transaction((tx) =>
            createInvitationAuth(tx, config).api.getSession({
              headers: request.headers,
            }),
          ),
        );
      },
      conversations: createConversationHttpHandlers({
        userId: session,
        admit: (project, actor, key, body) =>
          admitConversationTurn(project, actor, key, body, settings),
        history: (project, actor, after, limit) =>
          getConversationHistory(db, project, actor, after, limit),
        snapshot: (id, actor, after) =>
          getConversationTurnSnapshot(db, id, actor, after),
        cancel: (id, actor) => cancelConversationTurn(db, id, actor),
      }),
      builds: createBuildHttpHandlers({
        userId: session,
        admit: (body, actor, key) => admitBuild(body, actor, key, settings),
        snapshot: (id, actor) => getOwnedBuild(db, id, actor),
        events: (id, actor, after) => getOwnedBuildEvents(db, id, actor, after),
        cancel: (id, actor) => requestBuildCancellation(db, id, actor),
      }),
      previews: createPreviewHttpHandlers(db, {
        enabled: false,
        baseUrl: "http://preview.localhost:3003",
        user: async (headers) => {
          const actor = await session(headers);
          return actor
            ? {
                id: actor,
                authSessionId:
                  accessContext.getStore()?.principal?.sessionId ?? null,
              }
            : null;
        },
      }),
    },
    { web: config.webUrl, api: config.apiUrl },
  );
  const call = async (
    who: string,
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Response> =>
    app.request(`http://localhost:3002/api/${path}`, {
      method,
      headers: {
        Cookie: people.get(who)?.cookie ?? "",
        Origin: config.webUrl,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const settings = {
    db,
    defaultModel: "unused",
    resolveProvider: (id: string | undefined) => ({ id: id ?? "fixture" }),
  };
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../../migrations` });
    for (const name of [
      "creator",
      "editor",
      "viewer",
      "outsider",
      "administrator",
      "future",
    ]) {
      const id = await db.transaction((tx) =>
        createOwnerAccount(tx, config, {
          name,
          email: `${name}@example.test`,
          password: "fixture-password-123",
        }),
      );
      const login = await db.transaction((tx) =>
        createInvitationAuth(tx, config).api.signInEmail({
          body: {
            email: `${name}@example.test`,
            password: "fixture-password-123",
          },
          returnHeaders: true,
        }),
      );
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      people.set(name, { id, cookie, sessionId: "" });
      const value = await db.transaction((tx) =>
        createInvitationAuth(tx, config).api.getSession({
          headers: new Headers({ Cookie: cookie }),
        }),
      );
      if (!value) throw new Error("Fixture native session missing");
      people.get(name)!.sessionId = value.session.id;
    }
    await db.insert(schema.organization).values({
      id: "instance",
      slug: "fixture",
      name: "Fixture",
      createdAt: new Date(),
    });
    await db.insert(schema.instanceSetup).values({
      id: 1,
      ownerId: people.get("administrator")!.id,
      organizationId: "instance",
      initializedAt: new Date(),
    });
    await db.insert(schema.member).values(
      ["creator", "editor", "viewer", "administrator"].map((name) => ({
        id: crypto.randomUUID(),
        organizationId: "instance",
        userId: people.get(name)!.id,
        role: name === "administrator" ? "owner" : "member",
        createdAt: new Date(),
      })),
    );
    const [project] = await db
      .insert(schema.projects)
      .values({
        name: "Private collaboration fixture",
        userId: people.get("creator")!.id,
      })
      .returning();
    projectId = project!.id;
    const [provider] = await db
      .insert(schema.providerConnections)
      .values({
        label: "Local fixture",
        protocol: "ollama",
        kind: "local",
        endpoint: "http://127.0.0.1:11434",
      })
      .returning();
    providerId = provider!.id;
  }, 30000);
  afterAll(async () => {
    await connection.end();
  });
  test("native sessions see private projects only with a grant; instance owner has no bypass", async () => {
    expect((await call("", "projects/" + projectId)).status).toBe(401);
    for (const name of ["editor", "viewer", "outsider", "administrator"]) {
      expect((await call(name, "projects/" + projectId)).status).toBe(404);
      const list = (await (await call(name, "projects")).json()) as {
        projects: unknown[];
      };
      expect(list.projects).toHaveLength(0);
    }
    expect((await call("creator", "projects/" + projectId)).status).toBe(200);
    expect(
      (await call("viewer", "projects/" + projectId + "/access", "PATCH", {}))
        .status,
    ).toBe(400);
  });
  test("owner configures project model and selected sharing with exact reconciliation", async () => {
    const access = (await (
      await call("creator", `projects/${projectId}/access`)
    ).json()) as { revision: string };
    const modelResponse = await call(
      "creator",
      `projects/${projectId}/access/model`,
      "PATCH",
      {
        requestId: crypto.randomUUID(),
        expectedRevision: access.revision,
        connectionId: providerId,
        modelId: "fixture-model",
      },
    );
    expect(modelResponse.status).toBe(200);
    const model = (await modelResponse.json()) as { currentRevision: string };
    const input = {
      requestId: crypto.randomUUID(),
      expectedRevision: model.currentRevision,
      mode: "selected",
      instanceRole: "viewer",
      members: [
        { userId: people.get("editor")!.id, role: "editor" },
        { userId: people.get("viewer")!.id, role: "viewer" },
      ],
    };
    expect(
      (await call("creator", `projects/${projectId}/access`, "PATCH", input))
        .status,
    ).toBe(200);
    expect(
      (await call("creator", `projects/${projectId}/access`, "PATCH", input))
        .status,
    ).toBe(200);
    const status = (await (
      await call(
        "creator",
        `projects/${projectId}/access/actions/${input.requestId}`,
      )
    ).json()) as { action: unknown };
    expect(status.action).not.toBeNull();
    expect(
      (await call("editor", `projects/${projectId}/access`, "PATCH", input))
        .status,
    ).toBe(403);
    expect(
      (await call("outsider", `projects/${projectId}/access`, "PATCH", input))
        .status,
    ).toBe(404);
    for (const name of ["editor", "viewer"]) {
      const response = await call(name, `projects/${projectId}`);
      expect(response.status).toBe(200);
      const value = (await response.json()) as {
        capabilities: { role: string };
      };
      expect(value.capabilities.role).toBe(name);
    }
    expect((await call("administrator", `projects/${projectId}`)).status).toBe(
      404,
    );
  });
  test("sharing refuses forged origins, nonmember grants and stale updates without changing policy", async () => {
    const path = `projects/${projectId}/access`;
    const before = (await (await call("creator", path)).json()) as {
      revision: string;
    };
    const input = {
      requestId: crypto.randomUUID(),
      expectedRevision: before.revision,
      mode: "selected",
      instanceRole: "viewer",
      members: [{ userId: people.get("outsider")!.id, role: "viewer" }],
    };
    const forged = await app.request(`http://localhost:3002/api/${path}`, {
      method: "PATCH",
      headers: {
        Cookie: people.get("creator")!.cookie,
        Origin: "https://untrusted.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    expect(forged.status).toBe(403);
    expect((await call("creator", path, "PATCH", input)).status).toBe(400);
    expect(
      (
        await call("creator", path, "PATCH", {
          ...input,
          requestId: crypto.randomUUID(),
          expectedRevision: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    const after = (await (await call("creator", path)).json()) as {
      revision: string;
    };
    expect(after.revision).toBe(before.revision);
    expect(
      (await call("viewer", `projects/${projectId}/settings`)).status,
    ).toBe(404);
    expect(
      (await call("creator", `projects/${projectId}/settings`)).status,
    ).toBe(200);
  });
  test("admission racing with removal cannot execute after access is removed", async () => {
    const path = `projects/${projectId}/access`,
      editor = people.get("editor")!.id;
    const state = (await (await call("creator", path)).json()) as {
      revision: string;
    };
    const input = {
      requestId: crypto.randomUUID(),
      expectedRevision: state.revision,
      mode: "private",
      instanceRole: "viewer",
      members: [],
    };
    const raced = await Promise.allSettled([
      call("creator", path, "PATCH", input),
      admitConversationTurn(
        projectId,
        editor,
        crypto.randomUUID(),
        { message: "Race against removal", mode: "ask" },
        settings,
      ),
    ]);
    const change = raced[0],
      admission = raced[1];
    if (change.status !== "fulfilled") throw change.reason;
    if (change.value.status === 200) {
      expect(admission.status).toBe("rejected");
    } else {
      expect(change.value.status).toBe(409);
      expect(admission.status).toBe("fulfilled");
    }
    if (admission.status === "fulfilled")
      await db
        .update(schema.conversationTurns)
        .set({ status: "cancelled" })
        .where(eq(schema.conversationTurns.id, admission.value.turnId));
    let current = (await (await call("creator", path)).json()) as {
      revision: string;
    };
    expect(
      (
        await call("creator", path, "PATCH", {
          ...input,
          requestId: crypto.randomUUID(),
          expectedRevision: current.revision,
        })
      ).status,
    ).toBe(200);
    await expect(
      admitConversationTurn(
        projectId,
        editor,
        crypto.randomUUID(),
        { message: "After removal", mode: "ask" },
        settings,
      ),
    ).rejects.toMatchObject({ status: 404 });
    current = (await (await call("creator", path)).json()) as {
      revision: string;
    };
    expect(
      (
        await call("creator", path, "PATCH", {
          requestId: crypto.randomUUID(),
          expectedRevision: current.revision,
          mode: "selected",
          instanceRole: "viewer",
          members: [
            { userId: editor, role: "editor" },
            { userId: people.get("viewer")!.id, role: "viewer" },
          ],
        })
      ).status,
    ).toBe(200);
  });
  test("Editor work keeps its author; Viewer reads source/history but cannot contribute or cancel", async () => {
    const editor = people.get("editor")!.id,
      viewer = people.get("viewer")!.id,
      owner = people.get("creator")!.id;
    await expect(
      admitConversationTurn(
        projectId,
        viewer,
        crypto.randomUUID(),
        { message: "No write", mode: "ask" },
        settings,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      admitConversationTurn(
        projectId,
        editor,
        crypto.randomUUID(),
        { message: "Override", mode: "auto", model: "unapproved" },
        settings,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const turn = await admitConversationTurn(
      projectId,
      editor,
      crypto.randomUUID(),
      { message: "Build a shared app", mode: "auto" },
      settings,
    );
    const [editorAccount] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, editor));
    await expect(
      changeMemberAccess(
        db,
        people.get("administrator")!.id,
        new Headers({ Cookie: people.get("administrator")!.cookie }),
        {
          requestId: crypto.randomUUID(),
          targetId: editor,
          action: "suspend",
          expectedRevision: editorAccount!.accessRevision,
        },
        config,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const claim = await claimConversationTurn(db);
    if (!claim) throw new Error("Claim missing");
    const buildId = await admitConversationBuildAction(
      db,
      claim,
      {
        type: "propose_build",
        content: "I will build this.",
        prompt: "Build shared app",
      },
      settings,
    );
    const [job] = await db
      .select()
      .from(schema.buildJobs)
      .where(eq(schema.buildJobs.buildId, buildId));
    expect(job?.userId).toBe(editor);
    const history = await getConversationHistory(db, projectId, viewer);
    expect(history.messages[0]?.author?.id).toBe(editor);
    expect(history.messages[0]?.author?.name).toBe("editor");
    expect(JSON.stringify(history.messages[0]?.author)).not.toContain("email");
    expect(await requestBuildCancellation(db, buildId, viewer)).toBe(false);
    expect(await cancelConversationTurn(db, turn.turnId, viewer)).toBe(false);
    expect(await getOwnedBuild(db, buildId, viewer)).not.toBeNull();
    expect(
      (await getOwnedBuildEvents(db, buildId, viewer, 0)).length,
    ).toBeGreaterThan(0);
    const access = (await (
      await call("creator", `projects/${projectId}/access`)
    ).json()) as { revision: string };
    expect(
      (
        await call("creator", `projects/${projectId}/access`, "PATCH", {
          requestId: crypto.randomUUID(),
          expectedRevision: access.revision,
          mode: "private",
          instanceRole: "viewer",
          members: [],
        })
      ).status,
    ).toBe(409);
    expect(await requestBuildCancellation(db, buildId, owner)).toBe(true);
    await db
      .update(schema.conversationTurns)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(schema.conversationTurns.id, turn.turnId));
  });
  test("viewer preview cookie follows current grant and is revoked by narrowing", async () => {
    const editor = people.get("editor")!.id,
      viewer = people.get("viewer")!.id;
    const admitted = await admitBuild(
      { projectId, prompt: "Preview source" },
      editor,
      crypto.randomUUID(),
      settings,
    );
    await db
      .update(schema.buildJobs)
      .set({ status: "success" })
      .where(eq(schema.buildJobs.buildId, admitted.buildId));
    await db
      .update(schema.builds)
      .set({
        status: "success",
        files: [
          { path: "package.json", content: "{}" },
          {
            path: "app/page.tsx",
            content: "export default function Page(){return null}",
          },
        ],
      })
      .where(eq(schema.builds.id, admitted.buildId));
    await expect(
      admitPreview(db, admitted.buildId, viewer, crypto.randomUUID()),
    ).rejects.toMatchObject({ status: 403 });
    const preview = await admitPreview(
      db,
      admitted.buildId,
      editor,
      crypto.randomUUID(),
    );
    await db
      .update(schema.previews)
      .set({
        status: "ready",
        leaseExpiresAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 60000),
      })
      .where(eq(schema.previews.id, preview.previewId));
    expect(await getOwnedPreview(db, preview.previewId, viewer)).not.toBeNull();
    const grant = await issuePreviewGrant(
      db,
      preview.previewId,
      viewer,
      people.get("viewer")!.sessionId,
    );
    const cookie = await consumePreviewGrant(
      db,
      preview.previewId,
      grant);
    expect(cookie).not.toBeNull();
    expect(
      await authorizePreviewSession(db, preview.previewId, cookie!),
    ).toBe(viewer);
    expect(await touchPreviewViewer(db, preview.previewId, viewer)).toBe(true);
    const access = (await (
      await call("creator", `projects/${projectId}/access`)
    ).json()) as { revision: string };
    const remove = await call(
      "creator",
      `projects/${projectId}/access`,
      "PATCH",
      {
        requestId: crypto.randomUUID(),
        expectedRevision: access.revision,
        mode: "selected",
        instanceRole: "viewer",
        members: [{ userId: editor, role: "editor" }],
      },
    );
    expect(remove.status).toBe(200);
    expect(
      await authorizePreviewSession(db, preview.previewId, cookie!),
    ).toBeNull();
    expect(await getOwnedPreview(db, preview.previewId, viewer)).toBeNull();
    expect((await call("viewer", `projects/${projectId}`)).status).toBe(404);
    expect(await getOwnedBuild(db, admitted.buildId, viewer)).toBeNull();
    await expect(
      getConversationHistory(db, projectId, viewer),
    ).rejects.toMatchObject({ status: 404 });
    expect(await touchPreviewViewer(db, preview.previewId, viewer)).toBe(false);
    expect(await stopPreview(db, preview.previewId, viewer)).toBe(false);
    await expect(
      admitDeployment(db, {
        projectId,
        userId: editor,
        buildId: admitted.buildId,
        idempotencyKey: crypto.randomUUID(),
        target: {
          gitInstanceUrl: "http://git.test",
          repositoryOwner: "apps",
          coolifyInstanceUrl: "http://coolify.test",
          coolifyProjectUuid: "project",
          coolifyServerUuid: "server",
          coolifyEnvironmentName: "production",
        },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  test("Everyone includes future accepted members; unaccepted and suspended users stay out", async () => {
    const access = (await (
      await call("creator", `projects/${projectId}/access`)
    ).json()) as { revision: string };
    expect(
      (
        await call("creator", `projects/${projectId}/access`, "PATCH", {
          requestId: crypto.randomUUID(),
          expectedRevision: access.revision,
          mode: "instance",
          instanceRole: "viewer",
          members: [],
        })
      ).status,
    ).toBe(200);
    expect((await call("future", `projects/${projectId}`)).status).toBe(404);
    await db.insert(schema.member).values({
      id: crypto.randomUUID(),
      userId: people.get("future")!.id,
      organizationId: "instance",
      role: "member",
      createdAt: new Date(),
    });
    expect((await call("future", `projects/${projectId}`)).status).toBe(200);
    expect((await call("outsider", `projects/${projectId}`)).status).toBe(404);
    await db
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, people.get("future")!.id));
    expect((await call("future", `projects/${projectId}`)).status).toBe(401);
  });
  const browserTest =
    process.env.WRENLY_TEST_SHARING_BROWSER === "true" ? test : test.skip;
  browserTest(
    "real browser owner sharing, Editor prompt reload and Viewer access with native cookies",
    async () => {
      const directory = await mkdtemp(
          join(tmpdir(), "wrenly-sharing-browser-"),
        ),
        web = resolve(import.meta.dir, "../../../../../apps/web");
      const captures = process.env.WRENLY_TEST_ENTRY_SCREENSHOTS ?? directory;
      if (captures !== directory && !captures.startsWith("/tmp/"))
        throw new Error("Use temporary captures.");
      await mkdir(captures, { recursive: true });
      let bundle = "",
        scenario = "",
        sharingWrites = 0,
        mutationKeys: string[] = [],
        report: { ok?: boolean; error?: string } | null = null;
      const css = (
        await Promise.all(
          (
            await Array.fromAsync(
              new Bun.Glob("*.css").scan({
                cwd: join(web, ".next/static/css"),
              }),
            )
          ).map((file) =>
            readFile(join(web, ".next/static/css", file), "utf8"),
          ),
        )
      ).join("\n");
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/report") {
            report = (await request.json()) as { ok?: boolean; error?: string };
            return new Response("ok");
          }
          if (url.pathname === "/bundle.js")
            return new Response(bundle, {
              headers: { "Content-Type": "text/javascript" },
            });
          if (url.pathname === "/style.css")
            return new Response(css, {
              headers: { "Content-Type": "text/css" },
            });
          if (url.pathname === "/font.woff")
            return new Response(
              await readFile(join(web, "app/fonts/GeistVF.woff")),
              { headers: { "Content-Type": "font/woff" } },
            );
          if (url.pathname.startsWith("/api/")) {
            const headers = new Headers(request.headers);
            if (headers.get("origin") === server.url.origin)
              headers.set("origin", config.webUrl);
            const mutation =
              url.pathname === `/api/projects/${projectId}/access` &&
              request.method === "PATCH";
            const payload = mutation ? await request.text() : undefined;
            if (mutation) {
              sharingWrites++;
              const input = JSON.parse(payload!) as {
                requestId: string;
              };
              mutationKeys.push(input.requestId);
              if (scenario === "owner-retry" && sharingWrites === 1)
                return Response.json(
                  { error: "Fixture acknowledgement unavailable" },
                  { status: 503 },
                );
            }
            const response = await app.fetch(
              mutation
                ? new Request(request.url, {
                    method: request.method,
                    headers,
                    body: payload,
                  })
                : new Request(request, { headers }),
            );
            if (
              mutation &&
              scenario === "owner-uncertain" &&
              sharingWrites === 1
            )
              return Response.json(
                { error: "Fixture acknowledgement unavailable" },
                { status: 503 },
              );
            return response;
          }
          const login = people.get(
            scenario.startsWith("owner")
              ? "creator"
              : scenario === "editor"
                ? "editor"
                : "viewer",
          )!;
          const headers = new Headers({
            "Content-Type": "text/html; charset=utf-8",
          });
          for (const cookie of login.cookie.split("; "))
            headers.append(
              "Set-Cookie",
              cookie + "; Path=/; HttpOnly; SameSite=Lax",
            );
          return new Response(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>@font-face{font-family:Fixture;src:url(/font.woff);font-weight:100 900}:root{--font-geist-sans:Fixture;--font-geist-mono:monospace}body{margin:0}#root{height:100vh}</style><div id="root"></div><script type="module" src="/bundle.js"></script>',
            { headers },
          );
        },
      });
      let chrome: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const link = join(directory, "link.tsx"),
          configFile = join(directory, "tsconfig.json"),
          entry = join(directory, "fixture.tsx"),
          output = join(directory, "bundle.js");
        await writeFile(
          link,
          `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};export default function Link(props){return React.createElement('a',props)}`,
        );
        await writeFile(
          configFile,
          JSON.stringify({
            compilerOptions: {
              jsx: "react-jsx",
              paths: {
                "@/*": [web + "/*"],
                "next/link": [link],
                "@tanstack/react-query": [
                  Bun.resolveSync("@tanstack/react-query", web),
                ],
              },
            },
          }),
        );
        await writeFile(
          entry,
          `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};import{createRoot}from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};import{QueryClient,QueryClientProvider}from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};import{ThemeProvider}from ${JSON.stringify(join(web, "components/theme-provider.tsx"))};import{ProjectAccessSettings}from ${JSON.stringify(join(web, "components/workspace/settings/project-sharing.tsx"))};import{Workspace}from ${JSON.stringify(join(web, "components/workspace/workspace.tsx"))};
const name=new URLSearchParams(location.search).get('case');localStorage.setItem('wrenly-theme',name.includes('dark')?'dark':'light');const client=new QueryClient({defaultOptions:{queries:{retry:false}}});createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider,null,React.createElement(QueryClientProvider,{client},React.createElement(name.startsWith('owner')?ProjectAccessSettings:Workspace,{projectId:${JSON.stringify(projectId)}}))));const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const until=async(check,label)=>{for(let i=0;i<900;i++){if(check())return;await sleep(10)}throw Error('Sharing browser timeout: '+label)};const report=value=>fetch('/report',{method:'POST',body:JSON.stringify(value)});const button=text=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent.includes(text));
(async()=>{await until(()=>name.startsWith('owner')?document.querySelector('.project-sharing-panel'):document.querySelector('.workspace-frame'),'workspace');
if(['owner','owner-uncertain','owner-retry'].includes(name)){document.querySelector('input[name="project-visibility"]').click();button('Review access change').click();await until(()=>button('Confirm access'),'review');button('Confirm access').click();if(name!=='owner'){await until(()=>button('Check saved access'),'uncertain recovery');if(!document.querySelector('fieldset').disabled)throw Error('Unconfirmed change allowed edits');button('Check saved access').click();if(name==='owner-retry'){await until(()=>button('Retry this exact change'),'exact retry');button('Retry this exact change').click();}}await until(()=>document.querySelector('[role=status]')?.textContent.includes('saved'),'persist owner change');const value=await(await fetch('/api/projects/${projectId}/access')).json();if(value.mode!=='private')throw Error('UI save did not persist private access');}
if(name==='editor'){await until(()=>document.querySelector('textarea'),'editor composer');await until(()=>document.querySelector('.workspace-toolbar')?.textContent.includes('editor'),'editor role');await until(()=>document.querySelector('.workspace-user-label')?.textContent.includes('You'),'saved signed-in author');if(!sessionStorage.getItem('sent')){await until(()=>!document.querySelector('textarea').disabled,'editable composer');const field=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Browser collaborator prompt');field.dispatchEvent(new Event('input',{bubbles:true}));await sleep(20);document.querySelector('button[aria-label="Send prompt"]').click();await until(()=>document.body.textContent.includes('Browser collaborator prompt'),'saved prompt');sessionStorage.setItem('sent','yes');location.reload();return;}await until(()=>document.body.textContent.includes('Browser collaborator prompt'),'reloaded prompt');if(!document.body.textContent.includes('You'))throw Error('Signed-in author not identified');}
if(name==='viewer'){await until(()=>document.body.textContent.includes('Viewer access'),'read only role');if(!document.querySelector('textarea')?.disabled)throw Error('Viewer composer active');await until(()=>document.body.textContent.includes('Browser collaborator prompt'),'shared history');await until(()=>Array.from(document.querySelectorAll('.workspace-user-label')).some(node=>node.textContent.includes('editor')),'teammate author');}
if(document.documentElement.scrollWidth>innerWidth)throw Error('Sharing layout overflow');await report({ok:true});})().catch(error=>report({error:error.message}));`,
        );
        const build = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "build",
            entry,
            "--target=browser",
            "--outfile=" + output,
            "--define",
            'process.env.NODE_ENV="production"',
            "--define",
            "process.env.NEXT_PUBLIC_WEB_URL=" +
              JSON.stringify(server.url.origin),
            "--tsconfig-override=" + configFile,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        if ((await build.exited) !== 0)
          throw new Error(await new Response(build.stderr).text());
        bundle = await readFile(output, "utf8");
        for (const [name, width] of [
          ["owner", 1440],
          ["owner-uncertain", 390],
          ["owner-retry", 390],
          ["owner-dark", 1440],
          ["owner-small", 320],
          ["editor", 1440],
          ["viewer", 390],
        ] as const) {
          // Each scenario starts with a reviewed selected policy. No model inference runs.
          const access = (await (
            await call("creator", `projects/${projectId}/access`)
          ).json()) as { revision: string };
          const restored = await call(
            "creator",
            `projects/${projectId}/access`,
            "PATCH",
            {
              requestId: crypto.randomUUID(),
              expectedRevision: access.revision,
              mode: "selected",
              instanceRole: "viewer",
              members: [
                { userId: people.get("editor")!.id, role: "editor" },
                { userId: people.get("viewer")!.id, role: "viewer" },
              ],
            },
          );
          if (restored.status !== 200)
            throw new Error(
              "Browser fixture policy reset failed: " + (await restored.text()),
            );
          scenario = name;
          sharingWrites = 0;
          mutationKeys = [];
          report = null;
          chrome = Bun.spawn(
            [
              process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
              "--headless=new",
              "--disable-gpu",
              "--disable-background-networking",
              "--no-first-run",
              "--hide-scrollbars",
              "--virtual-time-budget=12000",
              `--user-data-dir=${join(directory, name)}`,
              `--window-size=${width},1100`,
              `--screenshot=${join(captures, name + ".png")}`,
              server.url.origin + "/?case=" + name,
            ],
            { stdout: "ignore", stderr: "ignore" },
          );
          await chrome.exited;
          chrome = undefined;
          const result = report as { ok?: boolean; error?: string } | null;
          expect(result?.error).toBeUndefined();
          expect(result?.ok).toBe(true);
          expect(sharingWrites).toBe(
            name === "owner-retry"
              ? 2
              : name === "owner" || name === "owner-uncertain"
                ? 1
                : 0,
          );
          if (name === "owner-retry")
            expect(mutationKeys[0]).toBe(mutationKeys[1]);
          // Browser prompt remains persisted, but fixture execution is closed before next policy change.
          await db
            .update(schema.conversationTurns)
            .set({ status: "completed" })
            .where(eq(schema.conversationTurns.status, "queued"));
        }
      } finally {
        chrome?.kill();
        await chrome?.exited;
        await server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    },
    90000,
  );
});
