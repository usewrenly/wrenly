import { describe, expect, test } from "bun:test";
import { AttachmentPolicyError } from "@wrenly/inference";
import { AttachmentStoreError } from "../../attachment-error";
import { createConversationHttpHandlers } from "../../../conversations/http/http";
import { createBuildHttpHandlers } from "../../../builds/http/http";

const PROJECT_ID = "101e4567-e89b-12d3-a456-426614174007";

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
}

describe("attachment admission HTTP error mapping", () => {
  test("conversation creation surfaces attachment store and policy errors as 4xx instead of 503", async () => {
    const storeHandlers = createConversationHttpHandlers({
      userId: async () => "owner",
      admit: async () => {
        throw new AttachmentStoreError(
          409,
          "This model is not configured for image input. Review its capability in Settings → Providers or remove the image.",
        );
      },
      history: async () => ({ messages: [], turns: [], latestTurn: null, nextCursor: null }),
      snapshot: async () => {
        throw new Error("unused");
      },
      cancel: async () => false,
    });
    const conflict = await storeHandlers.create(
      postRequest({ mode: "auto", message: "Describe this image" }),
      PROJECT_ID,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error:
        "This model is not configured for image input. Review its capability in Settings → Providers or remove the image.",
    });

    const policyHandlers = createConversationHttpHandlers({
      userId: async () => "owner",
      admit: async () => {
        throw new AttachmentPolicyError("Attach up to four files per request.");
      },
      history: async () => ({ messages: [], turns: [], latestTurn: null, nextCursor: null }),
      snapshot: async () => {
        throw new Error("unused");
      },
      cancel: async () => false,
    });
    const invalid = await policyHandlers.create(
      postRequest({ mode: "auto", message: "Describe this image" }),
      PROJECT_ID,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Attach up to four files per request.",
    });
  });

  test("build creation surfaces attachment store and policy errors as 4xx instead of 503", async () => {
    const storeHandlers = createBuildHttpHandlers({
      userId: async () => "owner",
      admit: async () => {
        throw new AttachmentStoreError(
          409,
          "Review this model’s image support in Settings → Providers.",
        );
      },
      snapshot: async () => null,
      events: async () => [],
      cancel: async () => false,
    });
    const conflict = await storeHandlers.create(
      postRequest({ prompt: "Build with screenshot", stack: "nextjs" }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "Review this model’s image support in Settings → Providers.",
    });

    const policyHandlers = createBuildHttpHandlers({
      userId: async () => "owner",
      admit: async () => {
        throw new AttachmentPolicyError("Attach up to four files per request.");
      },
      snapshot: async () => null,
      events: async () => [],
      cancel: async () => false,
    });
    const invalid = await policyHandlers.create(
      postRequest({ prompt: "Build with screenshot", stack: "nextjs" }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Attach up to four files per request.",
    });
  });
});
