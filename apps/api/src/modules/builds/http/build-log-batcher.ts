/**
 * Saving continuous Docker output in manageable batches.
 * Bounds buffered text and awaits persistence on drain so log failures cannot be silently lost or treated as successful validation.
 * No raw output is sent to a model outside the existing repair policy.
 */
const FLUSH_INTERVAL_MS = 100;
const MAX_PENDING_CHARS = 64_000;
const TRUNCATION_NOTICE =
  "[Live output truncated while persistence was catching up]\n";

export interface BuildLogBatcher {
  write: (chunk: string) => void;
  drain: () => Promise<void>;
}

/** Serializes bounded newline batches; failure aborts the resource adapter and remains observable on drain. */
export function createBuildLogBatcher(
  persist: (text: string) => Promise<void>,
  fail: (error: unknown) => void,
): BuildLogBatcher {
  let pending = "";
  let failure: unknown;
  let failed = false;
  let closed = false;
  let inFlight: Promise<void> | undefined;
  const flush = (final: boolean): Promise<void> => {
    if (inFlight) return inFlight;
    const end = final ? pending.length : pending.lastIndexOf("\n") + 1;
    if (!end || failed) return Promise.resolve();
    const text = pending.slice(0, end);
    pending = pending.slice(end);
    inFlight = Promise.resolve()
      .then(() => persist(text.replace(/\n$/, "")))
      .catch((error: unknown) => {
        failed = true;
        failure = error;
        fail(error);
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  const timer = setInterval(() => {
    void flush(false);
  }, FLUSH_INTERVAL_MS);
  return {
    write: (chunk) => {
      if (closed || failed) return;
      pending += chunk;
      if (pending.length > MAX_PENDING_CHARS)
        pending =
          TRUNCATION_NOTICE +
          pending.slice(-(MAX_PENDING_CHARS - TRUNCATION_NOTICE.length));
    },
    drain: async () => {
      closed = true;
      clearInterval(timer);
      await inFlight;
      await flush(true);
      if (failed)
        throw new Error("Live build log persistence failed.", {
          cause: failure,
        });
    },
  };
}
