/** The function is serialized after TypeScript compilation so its module has no imported dependencies. */
declare const AudioWorkletProcessor: {
  new (): { port: MessagePort };
};
declare function registerProcessor(
  name: string,
  processor: typeof AudioWorkletProcessor,
): void;
declare const sampleRate: number;
function registerCapture(): void {
  const maximumSamples = sampleRate * 60;
  let captured = 0;
  class Capture extends AudioWorkletProcessor {
    process(inputs: Float32Array[][]): boolean {
      const channels = inputs[0];
      if (
        !channels?.length ||
        channels.length > 2 ||
        captured >= maximumSamples
      )
        return captured < maximumSamples;
      const length = Math.min(channels[0]!.length, maximumSamples - captured);
      const mono = new Float32Array(length);
      for (let index = 0; index < length; index++) {
        let sample = 0;
        for (const channel of channels) sample += channel[index] ?? 0;
        mono[index] = sample / channels.length;
      }
      captured += length;
      this.port.postMessage(
        { samples: mono, finished: captured >= maximumSamples },
        [mono.buffer],
      );
      return captured < maximumSamples;
    }
  }
  registerProcessor("wrenly-dictation-capture", Capture);
}
/** Creates only repository-owned worklet code; recording data never becomes executable module text. */
export function captureWorkletSource(): string {
  return `(${registerCapture.toString()})();`;
}
