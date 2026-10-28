// Executes only the orchestrator with controlled adapters; generated PHP/JS is never run here.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseSkillGuidance } from "@wrenly/inference";
import { executeClaimedBuild } from "../builds/execution/build-executor";
import type { BuildClaim } from "../builds/persistence/build-job-store";
import type { AgentInput } from "../mcp/agent-client";
import { laravelFixture } from "../../../../../packages/sandbox/tests/laravel-fixture";
for (const stack of ["nextjs", "laravel"] as const)
  test(`${stack} executor forwards frozen Skills to generation and every repair`, async () => {
    const document =
      "---\nname: clear-copy\ndescription: Copy guidance\n---\nUse concrete labels.";
    const guidance = parseSkillGuidance({
      version: 1,
      skills: [
        {
          skillId: crypto.randomUUID(),
          versionId: crypto.randomUUID(),
          name: "clear-copy",
          description: "Copy guidance",
          document,
          sha256: createHash("sha256").update(document).digest("hex"),
          source: "authored",
          sourceUrl: null,
          versionLabel: null,
          licenseNotes: "",
        },
      ],
    });
    const claim: BuildClaim = {
      buildId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      token: crypto.randomUUID(),
      input: {
        prompt: "Build a directory",
        stack,
        model: "fixture",
        provider: "fixture",
        previousFiles: [],
        previousErrors: [],
        skillsV1: guidance,
      },
    };
    const requests: AgentInput[] = [];
    let validations = 0;
    const result = await executeClaimedBuild(
      claim,
      new AbortController().signal,
      {
        generate: async (_stack, input) => {
          requests.push(input);
          return {
            files:
              stack === "laravel"
                ? laravelFixture()
                : [{ path: "package.json", content: "{}" }],
          };
        },
        validate: async () =>
          ++validations === 1
            ? { success: false, output: "Fixture compiler error" }
            : { success: true, output: "Fixture succeeded" },
        progress: async () => {},
      },
    );
    expect(result.status).toBe("success");
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.skills_v1)).toEqual([
      guidance,
      guidance,
    ]);
    expect(requests[1]?.previousFiles?.length).toBeGreaterThan(0);
    expect(requests[1]?.previousErrors.at(-1)).toContain(
      "Fixture compiler error",
    );
    expect(claim.input.skillsV1).toEqual(guidance);
  });
