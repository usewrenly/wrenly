/** Opt-in tests run only the new isolated speech image with explicitly supplied public fixture/model files. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import manifest from "../../images/transcription/model-manifest.json";
const nativeTest =
  process.env.WRENLY_TEST_TRANSCRIPTION === "true" ? test : test.skip;
const DOCKER = ["docker", "--host", "unix:///var/run/docker.sock"];
const MODEL_PATH = process.env.WRENLY_TEST_TRANSCRIPTION_MODEL_PATH;
const FIXTURE_PATH = process.env.WRENLY_TEST_TRANSCRIPTION_FIXTURE_PATH;
async function command(args: string[]): Promise<string> {
  const child = Bun.spawn([...DOCKER, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, output, diagnostics] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code)
      throw Error(
        `Disposable transcription Docker command failed: ${diagnostics.slice(0, 1000)}`,
      );
    return output.trim();
  } finally {
    clearTimeout(timer);
  }
}
async function runFixture(
  disconnect: boolean,
  stall = false,
  forceOom = false,
): Promise<{ code: number; text: string; seconds: number }> {
  if (!MODEL_PATH?.startsWith("/") || !FIXTURE_PATH?.startsWith("/"))
    throw Error("Explicit absolute public fixture/model paths are required.");
  const model = await readFile(MODEL_PATH);
  if (
    model.length !== manifest.model.bytes ||
    createHash("sha256").update(model).digest("hex") !== manifest.model.sha256
  )
    throw Error("The model does not match the pinned public artifact.");
  const image = await command([
    "image",
    "inspect",
    "wrenly/transcription-runtime:1",
    "--format",
    "{{.Id}}",
  ]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw Error("Invalid local speech image identity.");
  const name = `wrenly-transcription-test-${crypto.randomUUID()}`;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await command([
      "create",
      "--name",
      name,
      "--label",
      "org.wrenly.test=transcription",
      "--network",
      "none",
      "--read-only",
      "--log-driver",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      "64",
      "--cpus",
      "2",
      "--memory",
      forceOom ? "32m" : "1g",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700",
      "--mount",
      `type=bind,src=${MODEL_PATH},dst=/model/ggml-base.bin,readonly`,
      "--interactive",
      image,
    ]);
    const start = performance.now();
    child = Bun.spawn([...DOCKER, "start", "--attach", "--interactive", name], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    if (!stall) await child.stdin.write(await readFile(FIXTURE_PATH));
    await child.stdin.flush();
    if (disconnect) child.stdin.end();
    const active = child;
    const timer = setTimeout(
      () => {
        void command(["kill", name]).catch(() => {});
        active.kill("SIGKILL");
      },
      disconnect ? 10_000 : 95_000,
    );
    let code: number;
    let text: string;
    try {
      [code, text] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const [inspection] = JSON.parse(await command(["inspect", name])) as Array<{
      State: { Running: boolean; OOMKilled: boolean };
      HostConfig: {
        NetworkMode: string;
        LogConfig: { Type: string };
        ReadonlyRootfs: boolean;
      };
      Config: { User: string };
    }>;
    expect(inspection?.State.Running).toBe(false);
    expect(inspection?.State.OOMKilled).toBe(forceOom);
    expect(inspection?.HostConfig.NetworkMode).toBe("none");
    expect(inspection?.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspection?.HostConfig.LogConfig.Type).toBe("none");
    expect(inspection?.Config.User).toBe("1000:1000");
    return { code, text, seconds: (performance.now() - start) / 1000 };
  } finally {
    child?.kill("SIGKILL");
    await child?.exited;
    await command(["rm", "--force", name]);
  }
}
nativeTest(
  "pinned multilingual engine transcribes known speech offline with no retained Docker logs",
  async () => {
    const result = await runFixture(false);
    expect(result.code).toBe(0);
    const value = JSON.parse(result.text) as { text: string };
    expect(value.text.toLowerCase()).toContain("country");
    expect(value.text.toLowerCase()).toContain("ask");
    expect(result.seconds).toBeLessThan(90);
  },
  110_000,
);
nativeTest(
  "closing the controller input terminates native inference rather than leaving an orphan",
  async () => {
    const result = await runFixture(true);
    expect(result.code).not.toBe(0);
    expect(result.text).toBe("");
    expect(result.seconds).toBeLessThan(10);
  },
  25_000,
);

nativeTest(
  "host adapter verifies the pinned artifacts, transcribes and releases exact containers",
  async () => {
    if (!MODEL_PATH || !FIXTURE_PATH)
      throw Error("Explicit public fixture paths required.");
    const { createWhisperTranscriptionRuntime } =
      await import("../../src/transcription/runtime");
    const instanceScope = createHash("sha256")
      .update(crypto.randomUUID())
      .digest("hex");
    const runtime = await createWhisperTranscriptionRuntime({
      modelPath: MODEL_PATH,
      instanceScope,
    });
    try {
      const audio = new Uint8Array(await readFile(FIXTURE_PATH));
      const text = await runtime.transcribe({
        audio,
        requestId: crypto.randomUUID(),
        signal: new AbortController().signal,
      });
      expect(text.toLowerCase()).toContain("country");
      const controller = new AbortController();
      const cancellationStarted = performance.now();
      const interrupted = runtime.transcribe({
        audio,
        requestId: crypto.randomUUID(),
        signal: controller.signal,
      });
      const timer = setTimeout(() => controller.abort(), 500);
      try {
        await expect(interrupted).rejects.toThrow();
      } finally {
        clearTimeout(timer);
      }
      expect((performance.now() - cancellationStarted) / 1000).toBeLessThan(10);
      expect(runtime.available()).toBe(true);
      const containers = JSON.parse(
        await command([
          "ps",
          "--all",
          "--filter",
          `label=org.wrenly.instance=${instanceScope}`,
          "--format",
          "json",
        ]).then(
          (output) => `[${output.split("\n").filter(Boolean).join(",")}]`,
        ),
      ) as unknown[];
      expect(containers).toHaveLength(0);
    } finally {
      await runtime.stop();
    }
    expect(runtime.available()).toBe(false);
  },
  110_000,
);

nativeTest(
  "native guardian expires an abandoned controller even before audio arrives",
  async () => {
    const result = await runFixture(false, true);
    expect(result.code).not.toBe(0);
    expect(result.text).toBe("");
    expect(result.seconds).toBeGreaterThan(85);
    expect(result.seconds).toBeLessThan(95);
  },
  110_000,
);

nativeTest(
  "memory exhaustion stops without returning partial words",
  async () => {
    const result = await runFixture(false, false, true);
    expect(result.code).not.toBe(0);
    expect(result.text).toBe("");
  },
  110_000,
);

nativeTest(
  "startup removes only an exact stopped recording and refuses an active one",
  async () => {
    if (!MODEL_PATH) throw Error("Explicit public model path required.");
    const { createWhisperTranscriptionRuntime } =
      await import("../../src/transcription/runtime");
    const instanceScope = createHash("sha256")
      .update(crypto.randomUUID())
      .digest("hex");
    const image = await command([
      "image",
      "inspect",
      "wrenly/transcription-runtime:1",
      "--format",
      "{{.Id}}",
    ]);
    const create = async (): Promise<string> =>
      command([
        "create",
        "--interactive",
        "--network",
        "none",
        "--read-only",
        "--log-driver",
        "none",
        "--memory",
        "1g",
        "--cpus",
        "2",
        "--label",
        "org.wrenly.module=transcription",
        "--label",
        `org.wrenly.instance=${instanceScope}`,
        "--label",
        `org.wrenly.request=${crypto.randomUUID()}`,
        image,
      ]);
    const stopped = await create();
    let active: string | undefined;
    try {
      const runtime = await createWhisperTranscriptionRuntime({
        modelPath: MODEL_PATH,
        instanceScope,
      });
      await expect(command(["inspect", stopped])).rejects.toThrow();
      await runtime.stop();
      active = await create();
      await command(["start", active]);
      await expect(
        createWhisperTranscriptionRuntime({
          modelPath: MODEL_PATH,
          instanceScope,
        }),
      ).rejects.toThrow("still stopping");
      const running = await command([
        "inspect",
        active,
        "--format",
        "{{.State.Running}}",
      ]);
      expect(running).toBe("true");
    } finally {
      if (active) await command(["rm", "--force", active]);
      // The id belongs only to this test; removing an already-absent stopped fixture is harmless.
      await command(["rm", "--force", stopped]).catch(() => {});
    }
  },
  30_000,
);
