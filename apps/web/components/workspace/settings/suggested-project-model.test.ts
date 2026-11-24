import { expect, test } from "bun:test";
import type { ModelsResponse } from "@/lib/models/discovery";
import {
  extractSavedConnectionId,
  resolveSuggestedProjectModel,
} from "./suggested-project-model";

const SAVED_CONN_A = "11111111-1111-4111-8111-111111111111";
const SAVED_VERS_A = "22222222-2222-4222-8222-222222222222";
const SAVED_CONN_B = "33333333-3333-4333-8333-333333333333";
const SAVED_VERS_B = "44444444-4444-4444-8444-444444444444";

const PROVIDER_A = `saved:${SAVED_CONN_A}:${SAVED_VERS_A}`;
const PROVIDER_B = `saved:${SAVED_CONN_B}:${SAVED_VERS_B}`;

const DISCOVERY: ModelsResponse = {
  providers: [
    {
      id: PROVIDER_A,
      label: "Cloud A",
      kind: "cloud",
      displayUrl: "https://a.example/v1",
      reachable: true,
      hint: null,
    },
    {
      id: PROVIDER_B,
      label: "Cloud B",
      kind: "cloud",
      displayUrl: "https://b.example/v1",
      reachable: true,
      hint: null,
    },
    {
      id: "ollama",
      label: "Ollama (local)",
      kind: "local",
      displayUrl: "http://localhost:11434",
      reachable: true,
      hint: null,
    },
  ],
  models: [
    { id: "model-a", label: "model-a", kind: "cloud", provider: PROVIDER_A },
    { id: "model-b", label: "model-b", kind: "cloud", provider: PROVIDER_B },
    { id: "local-only", label: "local-only", kind: "local", provider: "ollama" },
  ],
  envDefault: "model-a",
  defaultProvider: PROVIDER_A,
};

test("extractSavedConnectionId extracts UUIDs and rejects environment providers", () => {
  expect(extractSavedConnectionId(PROVIDER_A)).toBe(SAVED_CONN_A);
  expect(extractSavedConnectionId(SAVED_CONN_B)).toBe(SAVED_CONN_B);
  expect(extractSavedConnectionId("ollama")).toBeNull();
  expect(extractSavedConnectionId("env")).toBeNull();
  expect(extractSavedConnectionId("saved:bad-id")).toBeNull();
});

test("resolveSuggestedProjectModel prefers active browser selection, falls back to instance default, and ignores env models", () => {
  expect(
    resolveSuggestedProjectModel(DISCOVERY, {
      provider: PROVIDER_B,
      model: "model-b",
    }),
  ).toBe(JSON.stringify([SAVED_CONN_B, "model-b"]));

  expect(resolveSuggestedProjectModel(DISCOVERY, null)).toBe(
    JSON.stringify([SAVED_CONN_A, "model-a"]),
  );

  expect(
    resolveSuggestedProjectModel(DISCOVERY, {
      provider: "ollama",
      model: "local-only",
    }),
  ).toBe("");

  expect(
    resolveSuggestedProjectModel(DISCOVERY, {
      provider: PROVIDER_A,
      model: "missing-model",
    }),
  ).toBe("");
});
