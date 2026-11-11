import { expect, test } from "bun:test";
import {
  createProjectProductionCreationHandlers,
  type ProjectProductionCreationServices,
} from "./http";
const actor = {
    userId: "owner",
    sessionId: "session",
    revision: crypto.randomUUID(),
  },
  projectId = crypto.randomUUID();
const input = {
  requestId: crypto.randomUUID(),
  expectedRevision: crypto.randomUUID(),
  connectionId: crypto.randomUUID(),
  confirmCreate: true,
};
const receipt = {
  resourceId: crypto.randomUUID(),
  status: "queued",
  completedPhases: [],
  replayed: false,
};
const state = {
  projectId,
  projectRevision: input.expectedRevision,
  connectionId: input.connectionId,
  creation: {
    resourceId: receipt.resourceId,
    requestId: input.requestId,
    status: "queued",
    completedPhases: [],
    errorCode: null,
  },
};
function request(
  value: unknown = input,
  origin = "http://localhost:3000",
): Request {
  return new Request(
    `http://localhost:3002/api/projects/${projectId}/databases/production/creation`,
    {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(value),
    },
  );
}
function services(
  overrides: Partial<ProjectProductionCreationServices> = {},
): ProjectProductionCreationServices {
  return {
    principal: async () => actor,
    admit: async () => receipt,
    read: async () => state,
    ...overrides,
  };
}
test("creation saves once and exact request lookup never admits SQL work", async () => {
  let admissions = 0,
    lookup: string | undefined;
  const handlers = createProjectProductionCreationHandlers(
    services({
      admit: async (principal, id, value) => {
        expect(principal).toEqual(actor);
        expect(id).toBe(projectId);
        expect(value.requestId).toBe(input.requestId);
        admissions++;
        return receipt;
      },
      read: async (_principal, _id, id) => {
        lookup = id;
        return state;
      },
    }),
    "http://localhost:3000",
  );
  const response = await handlers.submit(request(), projectId);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual(receipt);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const read = await handlers.status(
    new Request("http://localhost:3002/status"),
    projectId,
    input.requestId,
  );
  expect(read.status).toBe(200);
  expect(lookup).toBe(input.requestId);
  expect(admissions).toBe(1);
});
test("foreign origins, malformed bodies and changed sessions cannot admit creation", async () => {
  let calls = 0;
  const base = services({
      admit: async () => {
        calls++;
        return receipt;
      },
    }),
    handlers = createProjectProductionCreationHandlers(
      base,
      "http://localhost:3000",
    );
  expect(
    (
      await handlers.submit(
        request(input, "https://foreign.example"),
        projectId,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await handlers.submit(
        request({ ...input, privateKey: "forbidden" }),
        projectId,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handlers.submit(
        request({ ...input, confirmCreate: false }),
        projectId,
      )
    ).status,
  ).toBe(400);
  let reads = 0;
  const changed = createProjectProductionCreationHandlers(
    {
      ...base,
      principal: async () =>
        ++reads === 1 ? actor : { ...actor, sessionId: "other" },
    },
    "http://localhost:3000",
  );
  expect((await changed.submit(request(), projectId)).status).toBe(401);
  expect(calls).toBe(0);
});
test("uncertain receipts and unsafe saved status fail without exposing private data", async () => {
  const unsafe = createProjectProductionCreationHandlers(
    services({
      admit: async () => ({ ...receipt, password: "must-not-leak" }),
      read: async () => ({ ...state, privateKey: "must-not-leak" }),
    }),
    "http://localhost:3000",
  );
  const submit = await unsafe.submit(request(), projectId);
  expect(submit.status).toBe(503);
  expect(await submit.text()).not.toContain("must-not-leak");
  const read = await unsafe.status(
    new Request("http://localhost:3002/status"),
    projectId,
  );
  expect(read.status).toBe(503);
  expect(await read.text()).not.toContain("must-not-leak");
  const empty = createProjectProductionCreationHandlers(
    services({ read: async () => ({ ...state, creation: null }) }),
    "http://localhost:3000",
  );
  expect(
    (
      await empty.status(
        new Request("http://localhost:3002/status"),
        projectId,
        input.requestId,
      )
    ).status,
  ).toBe(404);
});

test("status rejects foreign projects and invalid progress", async () => {
  for (const invalid of [
    { ...state, projectId: crypto.randomUUID() },
    { ...state, creation: { ...state.creation, completedPhases: ["schema"] } },
    { ...state, creation: { ...state.creation, status: "attached" } },
  ]) {
    const handlers = createProjectProductionCreationHandlers(
      services({ read: async () => invalid }),
      "http://localhost:3000",
    );
    expect(
      (
        await handlers.status(
          new Request("http://localhost:3002/status"),
          projectId,
        )
      ).status,
    ).toBe(503);
  }
});
