// Trusted toolchain only. Configuration arrives over stdin, never Docker Env/Cmd or a host file.
import { writeFile } from "node:fs/promises";
// Includes a bounded CA chain for verified Production upstreams; Development keeps its two-field payload.
const MAX_INPUT_BYTES = 48 * 1024;
const MAX_CA_BYTES = 32 * 1024;
async function main(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timer = setTimeout(() => process.exit(1), 10_000);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_INPUT_BYTES) throw new Error("Input limit");
      chunks.push(chunk.value);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          !["configuration", "authentication", "certificateAuthority"].includes(
            key,
          ),
      ) ||
      !("configuration" in input) ||
      typeof input.configuration !== "string" ||
      !("authentication" in input) ||
      typeof input.authentication !== "string"
    )
      throw new Error("Invalid configuration");
    if ("certificateAuthority" in input) {
      if (
        typeof input.certificateAuthority !== "string" ||
        !input.certificateAuthority.length ||
        Buffer.byteLength(input.certificateAuthority) > MAX_CA_BYTES ||
        !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(
          input.certificateAuthority,
        ) ||
        input.certificateAuthority.includes("PRIVATE KEY")
      )
        throw new Error("Invalid certificate authority");
      await writeFile(
        "/run/wrenly-db-config/upstream-ca.pem",
        input.certificateAuthority,
        { mode: 0o600, flag: "wx" },
      );
    }
    await writeFile(
      "/run/wrenly-db-config/pgbouncer.ini",
      input.configuration,
      { mode: 0o600, flag: "wx" },
    );
    await writeFile("/run/wrenly-db-config/users.txt", input.authentication, {
      mode: 0o600,
      flag: "wx",
    });
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const processHandle = Bun.spawn(
    ["pgbouncer", "/run/wrenly-db-config/pgbouncer.ini"],
    {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    },
  );
  process.exit(await processHandle.exited);
}
try {
  await main();
} catch {
  process.stderr.write("Database socket startup failed.\n");
  process.exit(1);
}
