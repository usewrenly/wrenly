/** Presentation rejects stale/private payloads and never infers write authority from visible resources. */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DatabaseOverview, type DatabaseOverviewState } from "../../database-overview";

const projectId = "00000000-0000-4000-8000-000000000001";
const resourceId = "00000000-0000-4000-8000-000000000002";
function status(manage = true): unknown {
  return { capabilities: { manage, developmentRows: manage, productionRows: manage }, resources: [{
    id: resourceId, projectId, environment: "development", provider: "local", status: "ready",
    revision: "00000000-0000-4000-8000-000000000003", schemaDigest: "a".repeat(64), errorCode: null,
    createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
  }], operations: [] };
}
function render(state: DatabaseOverviewState): string {
  return renderToStaticMarkup(<DatabaseOverview projectId={projectId} state={state}
    onReload={() => {}} onCreate={() => {}} onManage={() => {}} onLifecycle={() => {}} onOpen={() => {}} />);
}
test("owner sees confirmed resource actions; a Viewer gets schema access without management", () => {
  const owner = render({ status: "loaded", projectId, value: status() });
  expect(owner).toContain("Manage resource");
  expect(owner).toContain("Stop database");
  expect(owner).toContain("Browse data");
  const viewer = render({ status: "loaded", projectId, value: status(false) });
  expect(viewer).toContain("Inspect schema");
  expect(viewer).not.toContain("Manage resource");
  expect(viewer).not.toContain("Stop database");
  expect(viewer).not.toContain("Browse data");
  const editor = status(false) as { capabilities: { developmentRows: boolean } };
  editor.capabilities.developmentRows = true;
  const editorView = render({ status: "loaded", projectId, value: editor });
  expect(editorView).toContain("Browse data");
  expect(editorView).not.toContain("Manage resource");
});
test("stale project responses and unexpected private fields cannot appear as confirmed metadata", () => {
  const stale = render({ status: "loaded", projectId: resourceId, value: status() });
  expect(stale).toContain("Database status is unavailable");
  expect(stale).not.toContain("PostgreSQL");
  const foreign = status() as { resources: Array<{ projectId: string }> };
  foreign.resources[0]!.projectId = resourceId;
  expect(render({ status: "loaded", projectId, value: foreign })).toContain("Database status is unavailable");
  const privatePayload = { ...(status() as Record<string, unknown>), credentials: "PRIVATE_MUST_NOT_RENDER" };
  const invalid = render({ status: "loaded", projectId, value: privatePayload });
  expect(invalid).toContain("Database status is unavailable");
  expect(invalid).not.toContain("PRIVATE_MUST_NOT_RENDER");
});
test("loading and unavailable views cannot show cached resource details or creation controls", () => {
  expect(render({ status: "loading" })).toContain('aria-busy="true"');
  const unavailable = render({ status: "unavailable" });
  expect(unavailable).toContain("Reload status");
  expect(unavailable).not.toContain("Set up Development");
  expect(unavailable).not.toContain("PostgreSQL");
});
