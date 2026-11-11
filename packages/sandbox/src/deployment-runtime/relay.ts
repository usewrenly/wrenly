/** Byte-stream relay for trusted ingress and offline app HTTP. Callers supply only repository-owned endpoints. */
import {
  createServer,
  createConnection,
  type Server,
  type Socket,
  type ListenOptions,
  type NetConnectOpts,
} from "node:net";
const MAX_CONNECTIONS = 64;
const IDLE_TIMEOUT_MS = 60_000;
export interface RuntimeRelay {
  close: () => Promise<void>;
}
/** Backpressure belongs to pipe(); disconnecting either peer destroys both so abandoned sockets cannot accumulate. */
export async function startRuntimeRelay(input: {
  listen: ListenOptions;
  destination: NetConnectOpts;
  signal: AbortSignal;
}): Promise<RuntimeRelay> {
  const active = new Set<Socket>();
  let listener: Server | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      input.signal.removeEventListener("abort", abort);
      for (const connection of active) connection.destroy();
      if (listener?.listening) listener.close(() => resolve());
      else resolve();
    });
    return closing;
  };
  const abort = (): void => {
    void close();
  };
  try {
    input.signal.throwIfAborted();
    listener = createServer((incoming) => {
      if (active.size >= MAX_CONNECTIONS * 2 || input.signal.aborted) {
        incoming.destroy();
        return;
      }
      const upstream = createConnection(input.destination);
      active.add(incoming);
      active.add(upstream);
      const stop = (): void => {
        incoming.destroy();
        upstream.destroy();
      };
      for (const socket of [incoming, upstream]) {
        socket.setTimeout(IDLE_TIMEOUT_MS, stop);
        socket.once("error", stop);
        socket.once("close", () => {
          active.delete(socket);
          stop();
        });
      }
      incoming.pipe(upstream);
      upstream.pipe(incoming);
    });
    input.signal.addEventListener("abort", abort, { once: true });
    await new Promise<void>((resolve, reject) => {
      const cancelled = (): void =>
        reject(new Error("Runtime relay startup stopped."));
      const failed = (): void => {
        input.signal.removeEventListener("abort", cancelled);
        reject(new Error("Runtime relay could not listen."));
      };
      input.signal.addEventListener("abort", cancelled, { once: true });
      listener!.once("error", failed);
      listener!.listen({ ...input.listen, signal: input.signal }, () => {
        listener!.removeListener("error", failed);
        input.signal.removeEventListener("abort", cancelled);
        resolve();
      });
      if (input.signal.aborted) cancelled();
    });
    input.signal.throwIfAborted();
    listener.on("error", abort);
    return { close };
  } catch {
    await close();
    throw new Error("Runtime relay could not start.");
  }
}
