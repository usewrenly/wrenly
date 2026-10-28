import { expect, test } from "bun:test";
import { buildModelEnvironment } from "../../environment/model-environment";

test("passes server defaults even without an explicit model selection", () => {
  const environment = buildModelEnvironment(
    undefined,
    { baseUrl: "http://model.local/v1", apiKey: "inference-key" },
    {
      WRENLY_MODEL_NAME: "configured-model",
      WRENLY_DATABASE_URL: "private-db",
      WRENLY_AUTH_SECRET: "private-secret",
    },
  );
  expect(environment).toEqual({
    WRENLY_MODEL_NAME: "configured-model",
    WRENLY_MODEL_BASE_URL: "http://model.local/v1",
    WRENLY_MODEL_API_KEY: "inference-key",
  });
  expect(environment).not.toHaveProperty("WRENLY_DATABASE_URL");
  expect(environment).not.toHaveProperty("WRENLY_AUTH_SECRET");
});

test("uses an explicit model override with the resolved provider", () => {
  const environment = buildModelEnvironment(
    "selected-model",
    { baseUrl: "http://model.local/v1", apiKey: "inference-key" },
    { WRENLY_MODEL_NAME: "configured-model" },
  );
  expect(environment.WRENLY_MODEL_NAME).toBe("selected-model");
});

test("passes only inference scope and deadline alongside the selected credentials", () => {
  expect(
    buildModelEnvironment(
      "saved-model",
      {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "saved-key",
        networkScope: "local",
      },
      {
        WRENLY_MODEL_TIMEOUT_SECONDS: "180",
        WRENLY_DATABASE_URL: "private-db",
        WRENLY_AUTH_SECRET: "private-auth",
      },
    ),
  ).toEqual({
    WRENLY_MODEL_NAME: "saved-model",
    WRENLY_MODEL_BASE_URL: "http://localhost:11434/v1",
    WRENLY_MODEL_API_KEY: "saved-key",
    WRENLY_MODEL_NETWORK_SCOPE: "local",
    WRENLY_MODEL_TIMEOUT_SECONDS: "180",
  });
});
