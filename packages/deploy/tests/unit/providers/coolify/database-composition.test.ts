import { expect, test } from "bun:test";
import { createDatabaseRuntimeComposition } from "../../../../src/providers/coolify/database-runtime/composition";
const input = {
  deploymentId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  resourceId: crypto.randomUUID(),
  appImage: `registry.internal.test/wrenly/app@sha256:${"a".repeat(64)}`,
  ingressImage: `registry.internal.test/wrenly/ingress@sha256:${"b".repeat(64)}`,
  framework: "nextjs" as const,
};
test("composition gives the app no IP network and ingress no database socket or credentials", () => {
  const result = createDatabaseRuntimeComposition(input);
  const document = JSON.parse(result.document) as {
    services: {
      application: Record<string, unknown>;
      ingress: Record<string, unknown>;
    };
    volumes: { http: { name: string }; database: { name: string } };
  };
  expect(document.services.application.network_mode).toBe("none");
  expect(document.services.application.stdin_open).toBe(true);
  expect(document.services.ingress.volumes).toEqual([
    "http:/run/wrenly-http:ro",
  ]);
  expect(document.services.application.environment).toBeUndefined();
  expect(document.services.ingress.environment).toBeUndefined();
  expect(document.volumes.http.name).toBe(result.httpVolume);
  expect(document.volumes.database.name).toBe(result.databaseVolume);
  expect(result.document).not.toContain("docker.sock");
});
test("unbound identities and mutable image tags never become provider input", () => {
  for (const changed of [
    { ...input, deploymentId: "../foreign" },
    { ...input, appImage: "registry.internal.test/app:latest" },
    { ...input, ingressImage: input.appImage },
  ])
    expect(() => createDatabaseRuntimeComposition(changed)).toThrow();
  expect(
    createDatabaseRuntimeComposition({ ...input, framework: "laravel" })
      .document,
  ).toContain("/app/bootstrap/cache");
});
