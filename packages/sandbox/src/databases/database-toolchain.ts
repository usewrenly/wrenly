// Checks local trusted images and Docker capabilities before persistent database creation.
// This probe never pulls images, initializes storage or activates a database worker.
import Docker from "dockerode";
import { POSTGRES_RUNTIME_IMAGE } from "./database-runtime";
import { DATABASE_SOCKET_IMAGE } from "./database-socket";
const CLI_TIMEOUT_MS = 3000;
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
/** Does not pull images, initialize storage or change an operator's running services. */
export async function verifyDatabaseToolchain(): Promise<void> {
  try {
    if (process.platform !== "linux")
      throw new Error("Unsupported database host");
    const [postgres, socket, host] = await Promise.all([
      docker.getImage(POSTGRES_RUNTIME_IMAGE).inspect(),
      docker.getImage(DATABASE_SOCKET_IMAGE).inspect(),
      docker.info(),
    ]);
    if (
      host.OSType !== "linux" ||
      postgres.Config.User !== "70:70" ||
      socket.Config.User !== "1000:1000"
    )
      throw new Error("Unverified toolchain");
    const cli = Bun.spawn(
      [
        "docker",
        "--host",
        "unix:///var/run/docker.sock",
        "version",
        "--format",
        "{{.Server.Os}}",
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    );
    const timer = setTimeout(() => cli.kill("SIGKILL"), CLI_TIMEOUT_MS);
    try {
      const [code, output] = await Promise.all([
        cli.exited,
        new Response(cli.stdout).text(),
      ]);
      if (code !== 0 || output.trim() !== "linux")
        throw new Error("Docker CLI is unavailable");
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw new Error(
      "Database toolchain is unavailable. Build the PostgreSQL and database-socket images from packages/sandbox/images before creating a database.",
    );
  }
}
