import {
  DICTATION_LIMITS,
  encodeDictationWav,
  resampleDictation,
} from "@wrenly/audio";
import { captureWorkletSource } from "./capture-worklet";
export interface MicrophoneCapture {
  start(onLimit: () => void): Promise<void>;
  stop(): Promise<Uint8Array | null>;
  cancel(): Promise<void>;
}
/** Owns every microphone resource independently of React so late permission cannot revive cancelled capture. */
export function createMicrophoneCapture(): MicrophoneCapture {
  let generation = 0;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let moduleUrl: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chunks: Float32Array[] = [];
  let sampleCount = 0;
  let captureRate = 0;
  const release = async (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    worklet?.disconnect();
    source?.disconnect();
    worklet?.port.close();
    worklet = undefined;
    source = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
    const closing = context;
    context = undefined;
    const revoke = moduleUrl;
    moduleUrl = undefined;
    if (revoke) URL.revokeObjectURL(revoke);
    if (closing && closing.state !== "closed")
      await closing.close().catch(() => {});
  };
  const discard = (): void => {
    chunks = [];
    sampleCount = 0;
    captureRate = 0;
  };
  return {
    async start(onLimit) {
      if (stream || context) throw Error("A recording is already active.");
      const attempt = ++generation;
      if (
        !globalThis.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia ||
        !globalThis.AudioContext ||
        !globalThis.AudioWorkletNode
      )
        throw Error(
          "Microphone dictation needs HTTPS or localhost and a browser with AudioWorklet support.",
        );
      discard();
      try {
        const granted = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1 },
          video: false,
        });
        if (generation !== attempt) {
          for (const track of granted.getTracks()) track.stop();
          return;
        }
        stream = granted;
        context = new AudioContext();
        captureRate = context.sampleRate;
        if (
          !Number.isInteger(captureRate) ||
          captureRate < DICTATION_LIMITS.minimumCaptureRate ||
          captureRate > DICTATION_LIMITS.maximumCaptureRate
        )
          throw Error("This microphone's sample rate is not supported.");
        const maximumSamples = captureRate * DICTATION_LIMITS.maximumSeconds;
        moduleUrl = URL.createObjectURL(
          new Blob([captureWorkletSource()], { type: "text/javascript" }),
        );
        const activeContext = context;
        await activeContext.audioWorklet.addModule(moduleUrl);
        if (generation !== attempt) return;
        worklet = new AudioWorkletNode(
          activeContext,
          "wrenly-dictation-capture",
          {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: "explicit",
          },
        );
        let notified = false;
        const reachedLimit = (): void => {
          if (!notified && generation === attempt) {
            notified = true;
            void release().then(() => {
              if (generation === attempt) onLimit();
            });
          }
        };
        worklet.port.onmessage = (event: MessageEvent<unknown>): void => {
          if (
            generation !== attempt ||
            !event.data ||
            typeof event.data !== "object"
          )
            return;
          const data = event.data as { samples?: unknown; finished?: unknown };
          if (!(data.samples instanceof Float32Array)) return;
          const count = Math.min(
            data.samples.length,
            maximumSamples - sampleCount,
          );
          if (count > 0) {
            chunks.push(data.samples.slice(0, count));
            sampleCount += count;
          }
          if (data.finished === true || sampleCount >= maximumSamples)
            reachedLimit();
        };
        source = activeContext.createMediaStreamSource(granted);
        source.connect(worklet);
        worklet.connect(activeContext.destination);
        await activeContext.resume();
        if (generation !== attempt) return;
        timer = setTimeout(
          reachedLimit,
          DICTATION_LIMITS.maximumSeconds * 1000,
        );
      } catch (error) {
        // A cancelled attempt must not tear down a newer capture that reused this controller.
        if (generation === attempt) {
          await release();
          discard();
        }
        throw error;
      }
    },
    async stop() {
      ++generation;
      const saved = chunks,
        count = sampleCount,
        rate = captureRate;
      discard();
      await release();
      if (!count) return null;
      const mono = new Float32Array(count);
      let offset = 0;
      for (const chunk of saved) {
        mono.set(chunk, offset);
        offset += chunk.length;
      }
      return encodeDictationWav(resampleDictation(mono, rate));
    },
    async cancel() {
      ++generation;
      discard();
      await release();
    },
  };
}
