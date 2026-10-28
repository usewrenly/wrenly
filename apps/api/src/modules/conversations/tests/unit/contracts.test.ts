import { describe, expect, test } from "bun:test";
import {
  ConversationRequestSchema,
  validateConversationDecision,
} from "../../contracts/contracts";

describe("conversation action contract", () => {
  test("Plan allows discussion and rejects builds even for implementation prompts", () => {
    expect(
      ConversationRequestSchema.parse({ message: "Build it now", mode: "plan" })
        .mode,
    ).toBe("plan");
    expect(
      validateConversationDecision(
        { type: "answer", content: "Let us refine the requirements." },
        "plan",
      ).type,
    ).toBe("answer");
    expect(
      validateConversationDecision(
        { type: "clarify", content: "Who will use this app?" },
        "plan",
      ).type,
    ).toBe("clarify");
    expect(() =>
      validateConversationDecision(
        {
          type: "propose_build",
          content: "Start now",
          prompt: "Build the app",
        },
        "plan",
      ),
    ).toThrow("Plan mode cannot start a build");
  });
  test("defaults to Auto with an explicit empty base and normalizes whitespace", () => {
    expect(
      ConversationRequestSchema.parse({ message: "  Explain this  " }),
    ).toEqual({ message: "Explain this", mode: "auto", baseBuildId: null });
  });
  test("rejects blank, oversized and injected execution fields", () => {
    for (const body of [
      { message: " " },
      { message: "x".repeat(16_001) },
      { message: "Hi", command: "publish" },
    ])
      expect(ConversationRequestSchema.safeParse(body).success).toBe(false);
  });
  test("Ask rejects model-proposed builds independently of prompt wording", () => {
    expect(() =>
      validateConversationDecision(
        {
          type: "propose_build",
          content: "I will build it",
          prompt: "Build an app",
        },
        "ask",
      ),
    ).toThrow("Ask mode");
    expect(
      validateConversationDecision(
        { type: "answer", content: "Here is the saved error." },
        "ask",
      ).type,
    ).toBe("answer");
  });
  test("Build accepts clarification, but cannot silently complete as discussion", () => {
    expect(
      validateConversationDecision(
        { type: "clarify", content: "Which database?" },
        "build",
      ).type,
    ).toBe("clarify");
    expect(() =>
      validateConversationDecision(
        { type: "answer", content: "A database stores data." },
        "build",
      ),
    ).toThrow("Build mode");
  });
  test("Auto allows only the validated allowlist without arbitrary action targets", () => {
    expect(
      validateConversationDecision(
        {
          type: "propose_build",
          content: "Apply the requested change.",
          prompt: "Change the button color",
        },
        "auto",
      ).type,
    ).toBe("propose_build");
    for (const value of [
      { type: "deploy", content: "Publish" },
      {
        type: "propose_build",
        content: "Change",
        prompt: "Change",
        baseBuildId: crypto.randomUUID(),
      },
      { type: "answer", content: "" },
    ])
      expect(() => validateConversationDecision(value, "auto")).toThrow();
  });
});


test("database selection accepts only non-secret Development identities and is not model action authority", () => {
  const database = { version: 1 as const, environment: "development" as const, resourceId: crypto.randomUUID(), resourceRevision: crypto.randomUUID() };
  expect(ConversationRequestSchema.parse({ message: "Plan a booking app", mode: "plan", database }).database).toEqual(database);
  expect(ConversationRequestSchema.safeParse({ message: "Build", database: { ...database, password: "PRIVATE" } }).success).toBe(false);
  expect(ConversationRequestSchema.safeParse({ message: "Build", database: { ...database, environment: "production" } }).success).toBe(false);
  expect(() => validateConversationDecision({ type: "propose_build", content: "Build", prompt: "Build", database }, "auto")).toThrow();
});
