/**
 * Local Chrome fixture connection shared by browser acceptance tests.
 * Connects to the isolated profile's loopback debugger; callers own navigation,
 * explicit viewport setup, screenshots and browser-process cleanup.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// Startup polling and protocol deadlines keep a crashed browser from hanging acceptance.
const DEBUGGER_STARTUP_ATTEMPTS = 250;
const DEBUGGER_POLL_INTERVAL_MS = 20;
const DEBUGGER_TIMEOUT_MS = 5_000;

/** Connects to one local fixture page with bounded startup and command waits. */
export async function connectPage(profile: string): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
}> {
  let portText = "";
  for (let attempt = 0; attempt < DEBUGGER_STARTUP_ATTEMPTS; attempt++) {
    try {
      portText = await readFile(join(profile, "DevToolsActivePort"), "utf8");
      if (portText) break;
    } catch {
      /* Chrome writes this after starting its isolated debugger. */
    }
    await Bun.sleep(DEBUGGER_POLL_INTERVAL_MS);
  }
  const port = Number(portText.split("\n")[0]);
  if (!Number.isInteger(port) || port < 1025 || port > 65535)
    throw new Error("Invalid fixture debugging port.");
  const pages: unknown = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  if (!Array.isArray(pages)) throw new Error("Missing fixture page.");
  const page: unknown = pages.find(
    (item: unknown) =>
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "page",
  );
  if (
    !page ||
    typeof page !== "object" ||
    !("webSocketDebuggerUrl" in page) ||
    typeof page.webSocketDebuggerUrl !== "string"
  )
    throw new Error("Missing fixture debugger.");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 0;
  await new Promise<void>((resolveOpen, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Fixture debugger open timed out."));
    }, DEBUGGER_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      resolveOpen();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Fixture debugger failed."));
    };
  });
  socket.onmessage = (event) => {
    let value: unknown;
    try {
      value = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("id" in value) ||
      typeof value.id !== "number"
    )
      return;
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    clearTimeout(request.timer);
    if ("error" in value)
      request.reject(new Error("Fixture debugger command failed."));
    else request.resolve("result" in value ? value.result : undefined);
  };
  return {
    send(method, params = {}): Promise<unknown> {
      return new Promise((resolveCommand, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Fixture debugger command timed out."));
        }, DEBUGGER_TIMEOUT_MS);
        pending.set(id, { resolve: resolveCommand, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close(): void {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Fixture debugger closed."));
      }
      pending.clear();
      socket.close();
    },
  };
}
