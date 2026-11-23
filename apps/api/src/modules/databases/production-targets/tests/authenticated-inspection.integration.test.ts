/** Opt-in read-only acceptance against the separately created disposable PostgreSQL 17 TLS fixture. */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { inspectAuthenticatedProductionTarget } from "../authenticated-inspection";
import {
  pinProductionDatabaseTarget,
  type DatabaseAddressLookup,
  type PinnedProductionTarget,
} from "../target-policy";
const address = process.env.WRENLY_TEST_PRODUCTION_DATABASE_ADDRESS;
const certificatePath = process.env.WRENLY_TEST_PRODUCTION_DATABASE_CA;
const integration = address && certificatePath ? describe : describe.skip;
integration("authenticated Production connection inspection", () => {
  const target = {
    version: 1,
    environment: "production",
    host: "production.internal.test",
    port: 5432,
    database: "app",
    sslmode: "verify-full",
  };
  const controlDatabaseUrl =
    "postgresql://fixture@control.internal.test/wrenly";
  const resolver: DatabaseAddressLookup = async (host) => [
    {
      address: host === "control.internal.test" ? "10.250.250.250" : address!,
      family: 4,
    },
  ];
  let pinned: PinnedProductionTarget,
    certificateAuthority: string,
    clusterId: string;
  beforeAll(async () => {
    if (!address || isIP(address) !== 4 || !certificatePath)
      throw new Error("Missing disposable TLS fixture");
    certificateAuthority = await readFile(certificatePath, "utf8");
    pinned = await pinProductionDatabaseTarget(target, controlDatabaseUrl, {
      lookup: resolver,
    });
  });
  test("authenticates with verified TLS and returns only safe management facts", async () => {
    const result = await inspectAuthenticatedProductionTarget({
      target: pinned,
      credential: { user: "postgres", password: "fixture-only" },
      controlDatabaseUrl,
      controlClusterId: "1",
      certificateAuthority,
      lookup: resolver,
    });
    expect(result).toMatchObject({ database: "app", setupRole: "postgres" });
    expect(result.serverVersion).toBeGreaterThanOrEqual(170000);
    expect(result.clusterId).toMatch(/^[0-9]+$/);
    expect(JSON.stringify(result)).not.toContain("fixture-only");
    clusterId = result.clusterId;
  }, 20_000);
  test("refuses the actual control cluster identity even through unrelated endpoint names", async () => {
    if (!clusterId) throw new Error("Initial inspection did not pass");
    await expect(
      inspectAuthenticatedProductionTarget({
        target: pinned,
        credential: { user: "postgres", password: "fixture-only" },
        controlDatabaseUrl,
        controlClusterId: clusterId,
        certificateAuthority,
        lookup: resolver,
      }),
    ).rejects.toThrow("could not be verified");
  }, 20_000);
  test("does not fall back after a wrong password or untrusted certificate", async () => {
    for (const trusted of [true, false]) {
      await expect(
        inspectAuthenticatedProductionTarget({
          target: pinned,
          credential: {
            user: "postgres",
            password: trusted ? "wrong-fixture-password" : "fixture-only",
          },
          controlDatabaseUrl,
          controlClusterId: "1",
          ...(trusted ? { certificateAuthority } : {}),
          lookup: resolver,
        }),
      ).rejects.toThrow("could not be verified");
    }
  }, 20_000);
  test("a login that can inspect identity but cannot manage roles/databases is refused", async () => {
    const client = postgres({
      host: address,
      port: 5432,
      database: "app",
      user: "postgres",
      password: "fixture-only",
      ssl: {
        servername: target.host,
        rejectUnauthorized: true,
        ca: certificateAuthority,
      },
      max: 1,
    });
    const database = drizzle(client);
    try {
      await database.execute(
        sql`create role wrenly_fixture_inspector login password 'fixture-only' nosuperuser nocreatedb nocreaterole`,
      );
      await database.execute(
        sql`grant execute on function pg_catalog.pg_control_system() to wrenly_fixture_inspector`,
      );
      await expect(
        inspectAuthenticatedProductionTarget({
          target: pinned,
          credential: {
            user: "wrenly_fixture_inspector",
            password: "fixture-only",
          },
          controlDatabaseUrl,
          controlClusterId: "1",
          certificateAuthority,
          lookup: resolver,
        }),
      ).rejects.toThrow("could not be verified");
    } finally {
      await database.execute(
        sql`revoke execute on function pg_catalog.pg_control_system() from wrenly_fixture_inspector`,
      );
      await database.execute(sql`drop role if exists wrenly_fixture_inspector`);
      await client.end({ timeout: 1 });
    }
  }, 20_000);
  test("cancellation refuses inspection without returning partial readiness", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      inspectAuthenticatedProductionTarget({
        target: pinned,
        credential: { user: "postgres", password: "fixture-only" },
        controlDatabaseUrl,
        controlClusterId: "1",
        certificateAuthority,
        lookup: resolver,
        signal: abort.signal,
      }),
    ).rejects.toThrow("could not be verified");
  });
});
