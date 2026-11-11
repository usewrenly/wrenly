/** Progress saved Production setup and SQL creation without relying on an open browser. */
const POLL_MS = 1000;
const PASS_TIMEOUT_MS = 5 * 60_000;
export interface ProductionControlStages {
  connection: (signal: AbortSignal) => Promise<boolean>;
  host: (signal: AbortSignal) => Promise<boolean>;
  review: (signal: AbortSignal) => Promise<boolean>;
  handoff: (signal: AbortSignal) => Promise<boolean>;
  provision: (signal: AbortSignal) => Promise<boolean>;
}
/** Each adapter must claim saved work and preserve uncertain effects; this loop never retries a provider mutation itself. */
export function startProductionControlWorker(input: {
  stages: ProductionControlStages;
  log: (stage: keyof ProductionControlStages) => void;
  pollMs?: number;
}): { stop: () => Promise<void> } {
  let stopping = false,
    active: AbortController | undefined,
    wake: (() => void) | undefined;
  async function run(): Promise<void> {
    while (!stopping) {
      let worked = false;
      for (const stage of [
        "connection",
        "host",
        "review",
        "handoff",
        "provision",
      ] as const) {
        if (stopping) break;
        const controller = new AbortController();
        active = controller;
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(PASS_TIMEOUT_MS),
        ]);
        try {
          worked = (await input.stages[stage](signal)) || worked;
        } catch {
          if (!stopping) input.log(stage);
        } finally {
          active = undefined;
        }
      }
      if (!stopping && !worked)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = undefined;
            resolve();
          }, input.pollMs ?? POLL_MS);
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
    }
  }
  const running = run();
  let stopped: Promise<void> | undefined;
  return {
    stop: () => {
      stopping = true;
      active?.abort();
      wake?.();
      stopped ??= running;
      return stopped;
    },
  };
}
