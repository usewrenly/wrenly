import { expect, test } from "bun:test";
import { verifyImageApplicationAbsent } from "../../../../src/providers/coolify/application-absence";
import type { DeploymentProviderClient } from "../../../../src/http/provider-client";
const signal = new AbortController().signal;
function provider(
  value: unknown,
  project: unknown = { uuid: "project" },
): DeploymentProviderClient {
  return {
    request: async (method, endpoint) => {
      expect(method).toBe("GET");
      return endpoint === "/api/v1/projects/project" ? project : value;
    },
  };
}
test("absence requires a readable pinned project and complete valid collection", async () => {
  await verifyImageApplicationAbsent(
    provider([]),
    "project",
    "wrenly-project",
    signal,
  );
  await verifyImageApplicationAbsent(
    provider([{ uuid: "other", name: "Other application" }]),
    "project",
    "wrenly-project",
    signal,
  );
  for (const response of [
    null,
    {},
    { data: [] },
    [{ uuid: "app" }],
    [
      { uuid: "a", name: "one" },
      { uuid: "a", name: "two" },
    ],
    Array.from({ length: 1000 }, (_, index) => ({
      uuid: `app-${index}`,
      name: "other",
    })),
  ])
    await expect(
      verifyImageApplicationAbsent(
        provider(response),
        "project",
        "wrenly-project",
        signal,
      ),
    ).rejects.toThrow();
  await expect(
    verifyImageApplicationAbsent(
      provider([], { uuid: "other-project" }),
      "project",
      "wrenly-project",
      signal,
    ),
  ).rejects.toThrow("project");
});
test("matching apps, transport failure and cancellation never prove absence", async () => {
  await expect(
    verifyImageApplicationAbsent(
      provider([{ uuid: "app", name: "wrenly-project" }]),
      "project",
      "wrenly-project",
      signal,
    ),
  ).rejects.toThrow("matching application");
  await expect(
    verifyImageApplicationAbsent(
      {
        request: async () => {
          throw new Error("Network unavailable");
        },
      },
      "project",
      "wrenly-project",
      signal,
    ),
  ).rejects.toThrow("Network unavailable");
  await expect(
    verifyImageApplicationAbsent(
      provider([]),
      "project",
      "wrenly-project",
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
});
