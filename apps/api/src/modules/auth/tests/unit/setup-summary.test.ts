import { expect, test } from "bun:test";
import {
  summarizeSetup,
  createSetupSummaryHandler,
} from "../../setup/setup-summary";
const facts: Parameters<typeof summarizeSetup>[0] = {
  actorId: "owner",
  ownerId: "owner",
  hasProjects: false,
  previewEnabled: false,
  publishingEnabled: false,
  connections: [],
  savedDefault: null,
  legacy: null,
};
test("setup progress distinguishes configuration from provider health and optional runtime readiness", () => {
  expect(summarizeSetup(facts)).toMatchObject({
    role: "owner",
    accountConfigured: true,
    providerConfigured: false,
    defaultModel: { state: "missing" },
    hasProjects: false,
    preview: "operator-setup",
    connectionHealth: "not-checked",
  });
  expect(
    summarizeSetup({ ...facts, actorId: "user", previewEnabled: true }),
  ).toMatchObject({
    role: "user",
    preview: "enabled",
    connectionHealth: "not-checked",
  });
});
test("disabled/imported defaults never reappear as environment fallback", () => {
  const connection = {
    id: "saved",
    label: "Saved",
    enabled: false,
    protocol: "openai-compatible",
    kind: "cloud",
    credentialPresent: true,
    envSourceId: "env",
  };
  const summary = summarizeSetup({
    ...facts,
    connections: [connection],
    savedDefault: { connectionId: "saved", modelId: "fixture-model" },
    legacy: {
      id: "env",
      label: "Legacy",
      configured: true,
      modelId: "legacy-model",
    },
  });
  expect(summary.defaultModel.state).toBe("disabled");
  expect(summary.providerConfigured).toBe(false);
  expect(
    summarizeSetup({
      ...facts,
      connections: [connection],
      legacy: {
        id: "env",
        label: "Legacy",
        configured: true,
        modelId: "legacy-model",
      },
    }).defaultModel.state,
  ).toBe("missing");
  expect(
    summarizeSetup({
      ...facts,
      connections: [{ ...connection, enabled: true, credentialPresent: false }],
      savedDefault: { connectionId: "saved", modelId: "fixture-model" },
    }).defaultModel.state,
  ).toBe("unavailable");
});
test("authenticated setup summary rejects missing sessions before reading facts and returns failures as unavailable", async () => {
  let reads = 0,
    actor: string | null = null,
    fail = false;
  const handler = createSetupSummaryHandler({
    userId: async () => actor,
    summary: async () => {
      reads++;
      if (fail) throw new Error("private database details");
      return summarizeSetup(facts);
    },
  });
  expect((await handler(new Request("http://localhost"))).status).toBe(401);
  expect(reads).toBe(0);
  actor = "owner";
  const response = await handler(new Request("http://localhost"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(JSON.stringify(await response.json())).not.toContain("ownerId");
  fail = true;
  const failed = await handler(new Request("http://localhost"));
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private database");
});
