/** Private Unix control avoids signalling saved PIDs that could belong to another process. */
import { createConnection } from "node:net";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { State } from "../install/state";
const MAX_CONTROL_REPLY_BYTES = 2048;
const STATUS_TIMEOUT_MS = 5000;
// A timed-out Stop leaves the database running; it never assumes shutdown completed.
const STOP_TIMEOUT_MS = 90000;
export const RuntimeReply = z
  .object({
    id: z.uuid(),
    status: z.enum(["starting", "running", "stopping", "stopped", "failed"]),
    api: z.boolean(),
    web: z.boolean(),
  })
  .strict();
export type Reply = z.infer<typeof RuntimeReply>;
export function controlPath(state: State): string {
  return join(state.directory, ".wrenly", "control.sock");
}
export async function runtimeRequest(
  state: State,
  action: "status" | "stop",
): Promise<Reply | null> {
  try {
    const info = await lstat(controlPath(state));
    if (
      !info.isSocket() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("Runtime control identity changed.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(controlPath(state));
    let output = "";
    let settled = false;
    const timer = setTimeout(
      () => {
        socket.destroy();
        reject(
          new Error(
            "Runtime reply unconfirmed; inspect status before retrying.",
          ),
        );
      },
      action === "stop" ? STOP_TIMEOUT_MS : STATUS_TIMEOUT_MS,
    );
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(
        new Error(
          "Runtime control could not be confirmed. No saved PID was signalled.",
        ),
      );
    };
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        clearTimeout(timer);
        socket.destroy();
        settled = true;
        resolve(null);
      } else fail();
    });
    socket.once("end", () => {
      if (!settled) fail();
    });
    socket.once("connect", () =>
      socket.write(JSON.stringify({ version: 1, id: state.id, action }) + "\n"),
    );
    socket.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > MAX_CONTROL_REPLY_BYTES) return fail();
      if (output.includes("\n")) {
        try {
          const result = RuntimeReply.parse(JSON.parse(output.trim()));
          if (result.id !== state.id) throw new Error("Wrong runtime.");
          clearTimeout(timer);
          socket.end();
          settled = true;
          resolve(result);
        } catch {
          fail();
        }
      }
    });
  });
}
