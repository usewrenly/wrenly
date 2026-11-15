/** Trusted one-request guardian; temporary audio exists only inside the surrounding private tmpfs. */
import {
  DICTATION_LIMITS,
  WAV_HEADER_BYTES,
  validateDictationWav,
  validateTranscript,
} from "./audio/index";
const DEADLINE_MS = 90_000;
const OUTPUT_LIMIT_BYTES = DICTATION_LIMITS.maximumTranscriptBytes;
const AUDIO_PATH = "/tmp/recording.wav";
const MODEL_PATH = "/model/ggml-base.bin";
const reader = Bun.stdin.stream().getReader();
let child: ReturnType<typeof Bun.spawn> | undefined;
let remaining = new Uint8Array();
async function exact(length: number): Promise<Uint8Array> {
  const output = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    if (!remaining.length) {
      const next = await reader.read();
      if (next.done) throw Error("Input ended");
      remaining = next.value;
    }
    const count = Math.min(length - offset, remaining.length);
    output.set(remaining.subarray(0, count), offset);
    remaining = remaining.subarray(count);
    offset += count;
  }
  return output;
}
async function boundedOutput(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const output = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0,
    text = "";
  try {
    while (true) {
      const next = await output.read();
      if (next.done) return text + decoder.decode();
      length += next.value.length;
      if (length > OUTPUT_LIMIT_BYTES) throw Error("Output limit");
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    output.releaseLock();
  }
}
async function run(): Promise<void> {
  const header = await exact(WAV_HEADER_BYTES);
  const length = new DataView(header.buffer).getUint32(40, true);
  if (
    !length ||
    length > DICTATION_LIMITS.maximumUploadBytes - WAV_HEADER_BYTES
  )
    throw Error("Input limit");
  const body = await exact(length);
  if (remaining.length) throw Error("Unexpected trailing input");
  const audio = new Uint8Array(WAV_HEADER_BYTES + length);
  audio.set(header);
  audio.set(body, WAV_HEADER_BYTES);
  validateDictationWav(audio);
  await Bun.write(AUDIO_PATH, audio);
  child = Bun.spawn(
    [
      "/usr/local/bin/whisper-cli",
      "--model",
      MODEL_PATH,
      "--file",
      AUDIO_PATH,
      "--threads",
      "2",
      "--processors",
      "1",
      "--language",
      "auto",
      "--no-gpu",
      "--no-prints",
      "--no-timestamps",
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { HOME: "/tmp" },
    },
  );
  const disconnected = reader.read().then(() => {
    throw Error("Controller disconnected");
  });
  const completed = Promise.all([
    child.exited,
    boundedOutput(child.stdout),
  ]).then(([code, text]) => {
    if (code !== 0) throw Error("Transcription failed");
    return validateTranscript(text);
  });
  const text = await Promise.race([disconnected, completed]);
  process.stdout.write(JSON.stringify({ text }));
}
// The independent guardian still terminates native inference if the API disappears.
const timer = setTimeout(() => {
  child?.kill("SIGKILL");
  process.exit(124);
}, DEADLINE_MS);
try {
  await run();
} catch {
  child?.kill("SIGKILL");
  await child?.exited;
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await reader.cancel().catch(() => {});
  reader.releaseLock();
}
