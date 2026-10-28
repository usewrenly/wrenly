import { inspectAppDatabaseSchema } from "@wrenly/db/app-database-catalog";
// Bundled trusted code runs only in a private resource helper; role identities are resource-bound.
import { isIP } from "node:net";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  provisionAppDatabaseRoles,
  enforceAppDatabaseRolePolicy,
  terminateAppDatabaseSessions,
  validateAppDatabaseCredentials,
} from "@wrenly/db/app-database-roles";
const MAX_INPUT_BYTES = 8192;
const DEADLINE_MS = 15_000;
const READY = "WRENLY_DATABASE_ROLES_READY_V1\n";
function privateAddress(value: unknown): value is string {
  if (typeof value !== "string" || isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return (
    a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
  );
}
async function main(): Promise<void> {
  const reader = Bun.stdin.stream().getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_INPUT_BYTES) throw new Error("Input limit");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![3, 4].includes(Object.keys(input).length) ||
    Object.keys(input).some(
      (key) => !["resourceId", "address", "credentials", "mode"].includes(key),
    ) ||
    !("resourceId" in input) ||
    typeof input.resourceId !== "string" ||
    !("address" in input) ||
    !privateAddress(input.address) ||
    !("credentials" in input)
  )
    throw new Error("Invalid administrator request");
  const mode = "mode" in input ? input.mode : "provision";
  if (
    ![
      "provision",
      "inspect",
      "enforce-policy",
      "terminate-reader",
      "terminate-migrator",
      "terminate-runtime",
    ].includes(String(mode))
  )
    throw new Error("Invalid helper mode");
  let role: { user: string; password: string };
  if (mode === "inspect") {
    const value = input.credentials;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        input.resourceId,
      ) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !("migrator" in value) ||
      !value.migrator ||
      typeof value.migrator !== "object" ||
      Array.isArray(value.migrator) ||
      Object.keys(value.migrator).length !== 2 ||
      !("user" in value.migrator) ||
      value.migrator.user !==
        `wrenly_${input.resourceId.replaceAll("-", "")}_migrate` ||
      !("password" in value.migrator) ||
      typeof value.migrator.password !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.migrator.password)
    )
      throw new Error("Invalid read-only inspection identity");
    role = { user: value.migrator.user, password: value.migrator.password };
  } else
    role = validateAppDatabaseCredentials(
      input.resourceId,
      input.credentials,
    ).administrator;
  const client = postgres({
    host: input.address,
    port: 5432,
    database: "app",
    username: role.user,
    password: role.password,
    max: 1,
    connect_timeout: 3,
    idle_timeout: 2,
    prepare: false,
    onnotice: () => {},
    connection: {
      statement_timeout: 8000,
      lock_timeout: 1000,
      idle_in_transaction_session_timeout: 10000,
    },
  });
  try {
    if (mode === "inspect")
      process.stdout.write(
        `WRENLY_DATABASE_SCHEMA_V1:${await inspectAppDatabaseSchema(drizzle(client))}\n`,
      );
    else {
      if (mode === "enforce-policy")
        await enforceAppDatabaseRolePolicy(
          drizzle(client),
          input.resourceId,
          input.credentials,
        );
      else if (mode === "terminate-reader" || mode === "terminate-migrator" || mode === "terminate-runtime")
        await terminateAppDatabaseSessions(
          drizzle(client),
          input.resourceId,
          input.credentials,
          mode === "terminate-reader" ? "reader" : mode === "terminate-migrator" ? "migrator" : "runtime",
        );
      else
        await provisionAppDatabaseRoles(
          drizzle(client),
          input.resourceId,
          input.credentials,
        );
      process.stdout.write(READY);
    }
  } finally {
    await client.end({ timeout: 1 });
  }
}
const timer = setTimeout(() => {
  process.stderr.write("DATABASE_ROLE_CONFIGURATION_TIMEOUT\n");
  process.exit(1);
}, DEADLINE_MS);
try {
  await main();
} catch {
  process.stderr.write("DATABASE_ROLE_CONFIGURATION_FAILED\n");
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
