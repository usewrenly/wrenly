/** Trusted guardian owns the Unix listener; the generated child remains unable to replace its root-owned directory. */
import { chmod, chown, lstat } from "node:fs/promises";
import { startRuntimeRelay, type RuntimeRelay } from "./relay";
const HTTP_DIRECTORY = "/run/wrenly-http";
const HTTP_SOCKET = `${HTTP_DIRECTORY}/http.sock`;
const APPLICATION_PORT = 3000;
/** Call from the trusted application PID1 after the caller verifies this deployment's exact writable socket volume. */
export async function startApplicationHttpBridge(
  signal: AbortSignal,
): Promise<RuntimeRelay> {
  if (process.pid !== 1 || process.getuid?.() !== 0)
    throw new Error("Invalid application HTTP bridge context.");
  const directory = await lstat(HTTP_DIRECTORY);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== 0 ||
    (directory.mode & 0o022) !== 0
  )
    throw new Error("Application HTTP socket storage is unsafe.");
  const relay = await startRuntimeRelay({
    listen: { path: HTTP_SOCKET },
    destination: { host: "127.0.0.1", port: APPLICATION_PORT },
    signal,
  });
  try {
    // Ingress shares GID1000, but the generated app cannot unlink files in the
    // root-owned directory. The trusted bridge sets socket ownership explicitly.
    await chown(HTTP_SOCKET, 0, 1000);
    await chmod(HTTP_SOCKET, 0o660);
    return relay;
  } catch {
    await relay.close();
    throw new Error("Application HTTP socket could not be secured.");
  }
}
