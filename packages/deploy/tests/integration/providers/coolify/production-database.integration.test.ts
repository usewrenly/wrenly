/** Local HTTP contract fixture: an uncertain create is recovered without another mutation. */
import { expect, test } from "bun:test";
import { createDeploymentProviderClient } from "../../../../src/http/provider-client";
import { createPrivateProductionDatabase } from "../../../../src/providers/coolify/databases/creation";
import { findPrivateProductionDatabase } from "../../../../src/providers/coolify/databases/inspection";
import { databaseAdministrator } from "../../../../src/providers/coolify/databases/contract";

test("lost create acknowledgement is resolved through authenticated read-only HTTP", async () => {
  const intent = { resourceId: crypto.randomUUID(), operationId: crypto.randomUUID(), projectUuid: "project", serverUuid: "server", environmentUuid: "environment", destinationUuid: "destination" };
  let saved: Record<string, unknown> | null = null;
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (request.headers.get("authorization") !== "Bearer fixture-only") return new Response(null, { status: 401 });
    if (request.method === "POST" && path === "/api/v1/databases/postgresql") {
      const body: unknown = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) return new Response(null, { status: 400 });
      const input = body as Record<string, unknown>;
      saved = { ...input, uuid: "remote", database_type: "standalone-postgresql", enable_ssl: false, status: "exited:unhealthy", public_port: null, ports_mappings: null, destination: { uuid: "destination", server: { uuid: "server" } }, internal_db_url: "postgres://private@database/app" };
      // Simulate the provider saving the resource before an unsuccessful response.
      return new Response("private provider diagnostic", { status: 500 });
    }
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (path === "/api/v1/projects/project") return Response.json({ uuid: "project" });
    if (path === "/api/v1/databases") return Response.json(saved ? [saved] : []);
    if (path === "/api/v1/databases/remote" && saved) return Response.json(saved);
    return new Response(null, { status: 404 });
  } });
  try {
    const client = createDeploymentProviderClient({ origin: `http://127.0.0.1:${server.port}`, token: "fixture-only", authentication: "Bearer" });
    const signal = new AbortController().signal;
    await expect(createPrivateProductionDatabase(client, intent, { user: databaseAdministrator(intent), password: "a".repeat(64) }, signal)).rejects.toThrow("unconfirmed");
    const recovered = await findPrivateProductionDatabase(client, intent, signal);
    expect(recovered?.uuid).toBe("remote");
    expect(JSON.stringify(recovered)).not.toContain("private");
    expect(JSON.stringify(recovered)).not.toContain("postgres_password");
    expect(calls).toEqual(["POST /api/v1/databases/postgresql", "GET /api/v1/projects/project", "GET /api/v1/databases", "GET /api/v1/databases/remote"]);
  } finally {
    await server.stop(true);
  }
});
