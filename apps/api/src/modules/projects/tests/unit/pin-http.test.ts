import { expect, test } from "bun:test";
import type { db } from "@wrenly/db";
import { createProjectPinHandlers } from "../../pins/pin-http";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

test("project pin HTTP boundary enforces session, UUID, trusted origin, and strict JSON payload", async () => {
  let actor: string | null = null;
  const handlers = createProjectPinHandlers({} as typeof db, {
    webUrl: "http://localhost:3000",
    userId: async () => actor,
  });

  const unauthenticated = await handlers.save(
    new Request(`http://localhost:3002/api/projects/${VALID_ID}/pin`, {
      method: "PATCH",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pinned: true }),
    }),
    VALID_ID,
  );
  expect(unauthenticated.status).toBe(401);

  actor = "owner";
  const badId = await handlers.save(
    new Request("http://localhost:3002/api/projects/not-a-uuid/pin", {
      method: "PATCH",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pinned: true }),
    }),
    "not-a-uuid",
  );
  expect(badId.status).toBe(400);

  const foreignOrigin = await handlers.save(
    new Request(`http://localhost:3002/api/projects/${VALID_ID}/pin`, {
      method: "PATCH",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pinned: true }),
    }),
    VALID_ID,
  );
  expect(foreignOrigin.status).toBe(403);

  const extraKey = await handlers.save(
    new Request(`http://localhost:3002/api/projects/${VALID_ID}/pin`, {
      method: "PATCH",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pinned: true, extra: "nope" }),
    }),
    VALID_ID,
  );
  expect(extraKey.status).toBe(400);

  const nonBoolean = await handlers.save(
    new Request(`http://localhost:3002/api/projects/${VALID_ID}/pin`, {
      method: "PATCH",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pinned: "yes" }),
    }),
    VALID_ID,
  );
  expect(nonBoolean.status).toBe(400);
});
