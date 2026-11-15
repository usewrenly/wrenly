/** Adapters own cancellation/cleanup; resolving or rejecting means their execution has stopped. */
export interface TranscriptionAdapter {
  available(): boolean;
  transcribe(input: {
    audio: Uint8Array;
    requestId: string;
    signal: AbortSignal;
  }): Promise<string>;
}
export class TranscriptionError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 413 | 429 | 503 | 504,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}
