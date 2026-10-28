/** Disabled workspaces must not expose an unavailable Database tab; a configured pane works without a saved build. */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactPane } from "../../../artifacts/artifact-pane";
import { INITIAL_BUILD_STATE } from "../../../../../lib/builds/build-state";
const props = { projectId: "00000000-0000-4000-8000-000000000001", state: INITIAL_BUILD_STATE, liveUrl: null, onDeployed: (): void => {} };
test("Database navigation requires its explicitly installed pane", () => {
  const inactive = renderToStaticMarkup(<ArtifactPane {...props} tab="database" />);
  expect(inactive).not.toContain(`${props.projectId}-artifact-database`);
  const active = renderToStaticMarkup(<ArtifactPane {...props} tab="database" databasePane={<p>Confirmed resource surface</p>} />);
  expect(active).toContain(`${props.projectId}-artifact-database`);
  expect(active).toContain('Experimental');
  expect(active).toContain('Confirmed resource surface');
});
