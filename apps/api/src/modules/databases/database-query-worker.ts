// Trusted Docker-only helper exposes a fixed read-only projection, never arbitrary SQL.
import { z } from "zod";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { readAppDatabaseView } from "@wrenly/db/app-database-viewer";
import { DATABASE_SOCKET_PATH } from "@wrenly/sandbox/database-resource-policy";
const MAX_INPUT_BYTES = 8192,
  MAX_OUTPUT_BYTES = 128 * 1024;
const Input = z
  .object({
    resourceId: z.string().uuid(),
    user: z.string(),
    password: z.string().regex(/^[a-f0-9]{64}$/),
    table: z.string().max(63).optional(),
    rows: z.boolean(),
    after: z.string().max(1024).optional(),
  })
  .strict();
async function main(): Promise<void> {
  const reader = Bun.stdin.stream().getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_INPUT_BYTES) throw new Error("Input exceeds bounds");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const input = Input.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
  );
  if (input.user !== `wrenly_${input.resourceId.replaceAll("-", "")}_reader`)
    throw new Error("Invalid read-only role");
  const client = postgres({
    path: DATABASE_SOCKET_PATH,
    database: "app",
    username: input.user,
    password: input.password,
    max: 1,
    connect_timeout: 3,
    idle_timeout: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    const output = JSON.stringify(
      await readAppDatabaseView(drizzle(client), input),
    );
    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES)
      throw new Error("Output exceeds bounds");
    process.stdout.write(output);
  } finally {
    await client.end({ timeout: 1 });
  }
}
const timer = setTimeout(() => {
  process.stderr.write("DATABASE_QUERY_DEADLINE\n");
  process.exit(1);
}, 10000);
try {
  await main();
} catch {
  process.stderr.write("DATABASE_QUERY_FAILED\n");
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
