/** Runs trusted speech recognition without exposing the Docker socket or host recordings to the model. */
import Docker from "dockerode";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateDictationWav, validateTranscript } from "@wrenly/audio";
const IMAGE = "wrenly/transcription-runtime:1";
const REVISION = "d1be6fde11ac6e0407606b4e42fe72d34add8037";
const MODEL_HASH =
  "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
const MODEL_BYTES = 147_951_465;
const DEADLINE_MS = 90_000;
const OUTPUT_BYTES = 12 * 1024;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
function absent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404
  );
}
async function readOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0,
    result = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return result + decoder.decode();
      total += next.value.byteLength;
      if (total > OUTPUT_BYTES) throw Error("Transcription output limit");
      result += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
export interface WhisperTranscriptionRuntime {
  available(): boolean;
  transcribe(input: {
    audio: Uint8Array;
    requestId: string;
    signal: AbortSignal;
  }): Promise<string>;
  stop(): Promise<void>;
}
/** Provisioning is explicit; startup verifies existing local artifacts and never downloads a model/image. */
export async function createWhisperTranscriptionRuntime(options: {
  modelPath: string;
  instanceScope: string;
}): Promise<WhisperTranscriptionRuntime> {
  if (
    process.platform !== "linux" ||
    !isAbsolute(options.modelPath) ||
    !/^[a-f0-9]{64}$/.test(options.instanceScope)
  )
    throw Error("Invalid local transcription configuration.");
  const stat = await lstat(options.modelPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== MODEL_BYTES ||
    (await realpath(options.modelPath)) !== options.modelPath
  )
    throw Error("Use the verified regular multilingual base model file.");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(options.modelPath))
    hash.update(bytes);
  if (hash.digest("hex") !== MODEL_HASH)
    throw Error("The transcription model does not match the pinned checksum.");
  const image = await docker.getImage(IMAGE).inspect();
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
    image.Config.User !== "1000:1000" ||
    image.Config.Labels?.["org.wrenly.transcription.whisper-revision"] !==
      REVISION ||
    image.Config.Labels?.["org.wrenly.transcription.version"] !== "1"
  )
    throw Error("Build the verified Wrenly transcription runtime first.");
  const labels = {
    "org.wrenly.module": "transcription",
    "org.wrenly.instance": options.instanceScope,
  };
  const assertIdentity = (
    inspection: Docker.ContainerInspectInfo,
    requestId: string,
  ): void => {
    if (
      inspection.Image !== image.Id ||
      Object.entries({ ...labels, "org.wrenly.request": requestId }).some(
        ([key, value]) => inspection.Config.Labels?.[key] !== value,
      )
    )
      throw Error("Transcription cleanup identity mismatch.");
  };
  const remove = async (name: string, requestId: string): Promise<void> => {
    const container = docker.getContainer(name);
    try {
      const inspection = await container.inspect();
      assertIdentity(inspection, requestId);
      await container.remove({ force: true });
    } catch (error) {
      if (!absent(error)) throw error;
    }
    try {
      await container.inspect();
      throw Error("Transcription cleanup was not confirmed.");
    } catch (error) {
      if (!absent(error)) throw error;
    }
  };
  const prior = await docker.listContainers({
    all: true,
    filters: JSON.stringify({
      label: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
    }),
  });
  for (const item of prior) {
    const requestId = item.Labels?.["org.wrenly.request"];
    if (!requestId || !UUID.test(requestId))
      throw Error("An earlier transcription needs owner inspection.");
    const inspection = await docker.getContainer(item.Id).inspect();
    assertIdentity(inspection, requestId);
    if (inspection.State.Running)
      throw Error(
        "An earlier transcription is still stopping. Wait ninety seconds and restart dictation.",
      );
    await remove(item.Id, requestId);
  }
  let healthy = true,
    stopping = false;
  let running: Promise<string> | undefined;
  let abort: AbortController | undefined;
  const execute = async (input: {
    audio: Uint8Array;
    requestId: string;
    signal: AbortSignal;
  }): Promise<string> => {
    validateDictationWav(input.audio);
    if (!UUID.test(input.requestId)) throw Error("Invalid recording identity.");
    const current = await lstat(options.modelPath);
    if (
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      current.size !== stat.size ||
      current.mtimeMs !== stat.mtimeMs
    )
      throw Error(
        "The transcription model changed; restart after reviewing it.",
      );
    const executionId = crypto.randomUUID();
    const name = `wrenly-transcription-${options.instanceScope.slice(0, 16)}-${executionId}`;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    abort = new AbortController();
    const signal = AbortSignal.any([input.signal, abort.signal]);
    let expired = false;
    let cancellation: Promise<void> | undefined;
    const cancel = (): void => {
      if (child?.stdin && typeof child.stdin !== "number")
        void child.stdin.end();
      if (child && !cancellation) {
        cancellation = remove(name, executionId).catch(() => {
          healthy = false;
        });
      }
    };
    // Cleanup failure must keep capacity unavailable even if recognition itself succeeded.
    const cleanup = async (): Promise<void> => {
      try {
        await cancellation;
        await remove(name, executionId);
      } catch {
        healthy = false;
        throw Error(
          "Transcription cleanup needs owner review. Restart after inspecting the exact stopped recording container.",
        );
      } finally {
        child?.kill("SIGKILL");
        await child?.exited;
        abort = undefined;
      }
    };
    const timer = setTimeout(() => {
      expired = true;
      cancel();
    }, DEADLINE_MS);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) throw Error("Recording cancelled.");
      await docker.createContainer({
        name,
        Image: image.Id,
        Labels: { ...labels, "org.wrenly.request": executionId },
        User: "1000:1000",
        OpenStdin: true,
        StdinOnce: false,
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          Memory: 1024 ** 3,
          NanoCpus: 2_000_000_000,
          PidsLimit: 64,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          LogConfig: { Type: "none", Config: {} },
          Tmpfs: {
            "/tmp":
              "rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700",
          },
          Mounts: [
            {
              Type: "bind",
              Source: options.modelPath,
              Target: "/model/ggml-base.bin",
              ReadOnly: true,
            },
          ],
        },
      });
      if (signal.aborted || expired) throw Error("Recording cancelled.");
      const attached = Bun.spawn(
        [
          "docker",
          "--host",
          "unix:///var/run/docker.sock",
          "start",
          "--attach",
          "--interactive",
          name,
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        },
      );
      child = attached;
      await attached.stdin.write(input.audio);
      await attached.stdin.flush();
      if (signal.aborted || expired) cancel();
      const [code, text] = await Promise.all([
        attached.exited,
        readOutput(attached.stdout),
      ]);
      if (code !== 0 || signal.aborted || expired)
        throw expired
          ? new DOMException("Transcription timed out.", "TimeoutError")
          : Error("Transcription stopped.");
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || !("text" in value))
        throw Error("Invalid transcription response.");
      return validateTranscript(value.text);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      await cleanup();
    }
  };
  return {
    available: () => healthy && !stopping,
    async transcribe(input) {
      if (!healthy || stopping || running)
        throw Error("Local transcription is unavailable or busy.");
      running = execute(input);
      try {
        return await running;
      } finally {
        running = undefined;
      }
    },
    async stop() {
      stopping = true;
      abort?.abort();
      await running?.catch(() => {});
    },
  };
}
