import { describe, expect, test } from "bun:test";
import {
  executeClaimedBuild,
  type BuildExecutorDependencies,
} from "../../execution/build-executor";
import type {
  BuildClaim,
  BuildProgress,
} from "../../persistence/build-job-store";
import type { AgentInput } from "../../../mcp/agent-client";
import { laravelFixture } from "../../../../../../../packages/sandbox/tests/laravel-fixture";
import { BuildExecutionInterruptedError } from "../../execution/build-interruption";

test("unknown database work stops repair and preserves the interruption identity", async () => {
  const f = fixture();
  f.claim.input.databaseV1 = { version: 1, environment: "development", resourceId: crypto.randomUUID(), resourceRevision: crypto.randomUUID() };
  f.dependencies.validate = async () => { throw new BuildExecutionInterruptedError(); };
  await expect(executeClaimedBuild(f.claim, new AbortController().signal, f.dependencies)).rejects.toBeInstanceOf(BuildExecutionInterruptedError);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.prompt).toContain("managed Development PostgreSQL");
  expect(f.requests[0]?.prompt).not.toContain(f.claim.input.databaseV1.resourceId);
});

function fixture(): {
  claim: BuildClaim;
  dependencies: BuildExecutorDependencies;
  events: BuildProgress[];
  requests: AgentInput[];
} {
  const claim: BuildClaim = {
    buildId: "build",
    projectId: "project",
    token: "token",
    input: {
      prompt: "Add search",
      stack: "nextjs",
      model: "saved-model",
      provider: "saved-provider",
      previousFiles: [{ path: "package.json", content: '{"original":true}' }],
      previousErrors: ["Saved failure"],
    },
  };
  const events: BuildProgress[] = [];
  const requests: AgentInput[] = [];
  const dependencies: BuildExecutorDependencies = {
    generate: async (_stack, input) => {
      requests.push(input);
      return { files: [{ path: "package.json", content: '{"new":true}' }] };
    },
    validate: async () => ({ success: true, output: "Compiled" }),
    progress: async (_claim, event) => {
      events.push(event);
    },
  };
  return { claim, dependencies, events, requests };
}

describe("claimed build attempts", () => {
  test("Laravel repairs keep complete source in the versioned editing contract", async () => {
    const f = fixture();
    f.claim.input.stack = "laravel";
    f.claim.input.previousFiles = laravelFixture();
    f.dependencies.generate = async (_stack, input) => {
      f.requests.push(input);
      return { files: laravelFixture() };
    };
    let validations = 0;
    f.dependencies.validate = async () =>
      ++validations === 1
        ? { success: false, output: "Invalid Blade directive" }
        : { success: true, output: "Rendered" };
    expect(
      (
        await executeClaimedBuild(
          f.claim,
          new AbortController().signal,
          f.dependencies,
        )
      ).status,
    ).toBe("success");
    expect(f.requests).toHaveLength(2);
    expect(
      f.requests.every(
        (request) => request.previousFiles?.length === laravelFixture().length,
      ),
    ).toBe(true);
    expect(f.requests.every((request) => request.prompt === "Add search")).toBe(
      true,
    );
    expect(f.requests[1]?.previousErrors.at(-1)).toContain(
      "Invalid Blade directive",
    );
  });
  test("uses immutable saved settings and source, persisting source before validation", async () => {
    const f = fixture();
    f.dependencies.validate = async () => {
      expect(f.events.some((event) => event.type === "file_tree")).toBe(true);
      return { success: true, output: "Compiled" };
    };
    expect(
      await executeClaimedBuild(
        f.claim,
        new AbortController().signal,
        f.dependencies,
      ),
    ).toEqual({ status: "success" });
    expect(f.requests[0]?.model).toBe("saved-model");
    expect(f.requests[0]?.provider).toBe("saved-provider");
    expect(f.requests[0]?.prompt).toBe("Add search");
    expect(f.requests[0]?.previousFiles?.[0]?.content).toContain("original");
    expect(f.requests[0]?.previousErrors).toEqual(["Saved failure"]);
    expect(f.claim.input.previousErrors).toEqual(["Saved failure"]);
  });
  test("repair receives current generated source and compiler output", async () => {
    const f = fixture();
    let attempts = 0;
    f.dependencies.validate = async () =>
      ++attempts === 1
        ? {
            success: false,
            output: "Missing component",
            error: "Compiler failed",
          }
        : { success: true, output: "Compiled" };
    expect(
      (
        await executeClaimedBuild(
          f.claim,
          new AbortController().signal,
          f.dependencies,
        )
      ).status,
    ).toBe("success");
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.previousFiles?.[0]?.content).toContain("new");
    expect(f.requests[1]?.previousFiles?.[0]?.content).not.toContain(
      "original",
    );
    expect(f.requests[1]?.previousErrors.at(-1)).toContain("Missing component");
  });
  test("caps attempts and preserves diagnostic progress for all failures", async () => {
    const f = fixture();
    f.dependencies.validate = async () => ({
      success: false,
      output: "Compiler detail",
      error: "Failed",
    });
    const result = await executeClaimedBuild(
      f.claim,
      new AbortController().signal,
      f.dependencies,
    );
    expect(result.status).toBe("failed");
    expect(f.requests).toHaveLength(3);
    expect(f.events.filter((event) => event.type === "log_line")).toHaveLength(
      3,
    );
  });
  test("malformed generation is repairable but never reaches the sandbox", async () => {
    const f = fixture();
    let generations = 0;
    let validations = 0;
    f.dependencies.generate = async () => {
      generations++;
      return { files: [{ path: "readme.md", content: "No package manifest" }] };
    };
    f.dependencies.validate = async () => {
      validations++;
      return { success: true, output: "" };
    };
    expect(
      (
        await executeClaimedBuild(
          f.claim,
          new AbortController().signal,
          f.dependencies,
        )
      ).status,
    ).toBe("failed");
    expect(generations).toBe(3);
    expect(validations).toBe(0);
  });
  test("failed persistence never causes another model call", async () => {
    const f = fixture();
    f.dependencies.progress = async (_claim, event) => {
      if (event.type === "file_tree") throw new Error("Database unavailable");
    };
    await expect(
      executeClaimedBuild(
        f.claim,
        new AbortController().signal,
        f.dependencies,
      ),
    ).rejects.toThrow("Database unavailable");
    expect(f.requests).toHaveLength(1);
  });
  test("abort prevents further attempts and propagates through the same signal", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.dependencies.generate = async (_stack, _input, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error("Cancelled"));
      throw signal.reason;
    };
    await expect(
      executeClaimedBuild(f.claim, controller.signal, f.dependencies),
    ).rejects.toThrow("Cancelled");
    expect(f.events.filter((event) => event.type === "status")).toHaveLength(1);
  });
  test("validation success remains success when cancellation arrives at completion", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.dependencies.validate = async () => {
      controller.abort(new Error("Late cancel"));
      return { success: true, output: "Compiled" };
    };
    expect(
      await executeClaimedBuild(f.claim, controller.signal, f.dependencies),
    ).toEqual({ status: "success" });
  });
  test("streamed validation output is not appended again in the terminal summary", async () => {
    const f = fixture();
    f.dependencies.streamsValidationLogs = true;
    await executeClaimedBuild(
      f.claim,
      new AbortController().signal,
      f.dependencies,
    );
    const diagnostics = f.events.filter((event) => event.type === "log_line");
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).not.toContain("Compiled");
    expect(JSON.stringify(diagnostics)).toContain("Sandbox succeeded");
  });
  test("unexpected sandbox errors stop retries until scheduler cleanup", async () => {
    const f = fixture();
    f.dependencies.validate = async () => {
      throw new Error("Container status unknown");
    };
    await expect(
      executeClaimedBuild(
        f.claim,
        new AbortController().signal,
        f.dependencies,
      ),
    ).rejects.toThrow("safely");
    expect(f.requests).toHaveLength(1);
  });
});

test("actual generation boundaries preserve attempt identity and persistence failures never become model repairs", async () => {
  const f = fixture();
  expect(
    (
      await executeClaimedBuild(
        f.claim,
        new AbortController().signal,
        f.dependencies,
      )
    ).status,
  ).toBe("success");
  expect(f.events.filter((event) => event.type === "activity_v1")).toEqual([
    {
      type: "activity_v1",
      attempt: 1,
      operation: "generation",
      state: "started",
    },
    {
      type: "activity_v1",
      attempt: 1,
      operation: "generation",
      state: "completed",
    },
    {
      type: "activity_v1",
      attempt: 1,
      operation: "source",
      state: "completed",
    },
  ]);
  const failing = fixture();
  failing.dependencies.progress = async (_claim, event) => {
    if (event.type === "activity_v1" && event.state === "completed")
      throw new Error("Lost persistence");
  };
  await expect(
    executeClaimedBuild(
      failing.claim,
      new AbortController().signal,
      failing.dependencies,
    ),
  ).rejects.toThrow("Lost persistence");
  expect(failing.requests).toHaveLength(1);
});
