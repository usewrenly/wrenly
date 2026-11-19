import { expect, test } from "bun:test";
import { matchesRuntimeVolumeBindings } from "./runtime-volume-bindings";
const id = crypto.randomUUID();
const http = `wrenly-deployment-http-${id}:/run/wrenly-http:rw`;
const database = `wrenly-deployment-db-${id}:/run/wrenly-database:ro`;
test("accepts only the exact named-volume Compose representation", () => {
  expect(matchesRuntimeVolumeBindings(null, id, "application")).toBe(true);
  expect(matchesRuntimeVolumeBindings([database, http], id, "application")).toBe(true);
  expect(matchesRuntimeVolumeBindings([http.replace(/:rw$/, ":ro")], id, "ingress")).toBe(true);
  for (const bindings of [[http], [http, database, database], [http, database.replace(/:ro$/, ":rw")], [http, "/host:/run/wrenly-database:ro"], [http, database + ",nocopy"], [http.replace(id, crypto.randomUUID()), database]]) {
    expect(matchesRuntimeVolumeBindings(bindings, id, "application")).toBe(false);
  }
  expect(matchesRuntimeVolumeBindings([http], id, "ingress")).toBe(false);
});
