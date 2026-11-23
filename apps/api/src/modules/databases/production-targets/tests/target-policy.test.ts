import { expect, test } from "bun:test";
import { ProductionDatabaseTarget } from "@wrenly/db/production-database-target-contract";
import {
  pinProductionDatabaseTarget,
  recheckProductionDatabaseTarget,
  type DatabaseAddressLookup,
} from "../target-policy";
const TARGET: ProductionDatabaseTarget = {
  version: 1,
  environment: "production",
  host: "database.internal.test",
  port: 5432,
  database: "booking",
  sslmode: "verify-full",
};
const CONTROL =
  "postgresql://control:private-password@control.internal.test/wrenly";
function resolver(
  addresses: string[],
  control = ["192.168.30.2"],
): DatabaseAddressLookup {
  return async (host) =>
    (host === TARGET.host ? addresses : control).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
}

test("pins every private address in canonical order without opening a connection", async () => {
  const pinned = await pinProductionDatabaseTarget(TARGET, CONTROL, {
    lookup: resolver(["10.30.0.2", "10.30.0.1", "10.30.0.2"]),
  });
  expect(pinned).toEqual({
    target: TARGET,
    addresses: ["10.30.0.1", "10.30.0.2"],
  });
  expect(JSON.stringify(pinned)).not.toContain("private-password");
});
for (const ip of [
  "127.0.0.1",
  "169.254.169.254",
  "100.100.100.200",
  "8.8.8.8",
  "0.0.0.0",
  "224.0.0.1",
  "::1",
  "fe80::1",
  "2001:db8::1",
  "::ffff:10.30.0.1",
  "::ffff:a1e:1",
]) {
  test(`refuses unsafe address ${ip}`, async () => {
    await expect(
      pinProductionDatabaseTarget(TARGET, CONTROL, { lookup: resolver([ip]) }),
    ).rejects.toThrow("could not be verified");
  });
}
test("one private answer does not excuse a forbidden DNS answer", async () => {
  await expect(
    pinProductionDatabaseTarget(TARGET, CONTROL, {
      lookup: resolver(["10.30.0.1", "169.254.169.254"]),
    }),
  ).rejects.toThrow();
});
test("refuses the control cluster through an alias even with a different port and database", async () => {
  await expect(
    pinProductionDatabaseTarget(
      { ...TARGET, port: 6543, database: "another" },
      CONTROL,
      { lookup: resolver(["10.30.0.1"], ["10.30.0.1"]) },
    ),
  ).rejects.toThrow();
});
test("canonical IPv6 identities cannot bypass control-cluster isolation", async () => {
  await expect(
    pinProductionDatabaseTarget(TARGET, CONTROL, {
      lookup: resolver(["fd00:0:0:0:0:0:0:2"], ["fd00::2"]),
    }),
  ).rejects.toThrow();
  expect(
    (
      await pinProductionDatabaseTarget(TARGET, CONTROL, {
        lookup: resolver(["fd00:0:0:0:0:0:0:2"]),
      })
    ).addresses,
  ).toEqual(["fd00::2"]);
});
test("refuses empty, oversized and inconsistent resolver answers", async () => {
  for (const addresses of [
    [],
    Array.from({ length: 17 }, (_, i) => `10.30.0.${i + 1}`),
  ])
    await expect(
      pinProductionDatabaseTarget(TARGET, CONTROL, {
        lookup: resolver(addresses),
      }),
    ).rejects.toThrow();
  await expect(
    pinProductionDatabaseTarget(TARGET, CONTROL, {
      lookup: async () => [{ address: "10.30.0.1", family: 6 }],
    }),
  ).rejects.toThrow();
});
test("rejects TLS downgrades, credential URLs and configuration fragments", () => {
  for (const value of [
    { ...TARGET, sslmode: "require" },
    { ...TARGET, sslmode: "disable" },
    { ...TARGET, host: "postgresql://user:password@db.test" },
    { ...TARGET, host: "database.internal.test\nport=5433" },
    { ...TARGET, password: "secret" },
    { ...TARGET, database: "booking\nadmin=1" },
    { ...TARGET, environment: "development" },
  ])
    expect(ProductionDatabaseTarget.safeParse(value).success).toBe(false);
});
test("changed DNS requires a new review while answer ordering does not", async () => {
  const saved = await pinProductionDatabaseTarget(TARGET, CONTROL, {
    lookup: resolver(["10.30.0.2", "10.30.0.1"]),
  });
  expect(
    await recheckProductionDatabaseTarget(saved, CONTROL, {
      lookup: resolver(["10.30.0.1", "10.30.0.2"]),
    }),
  ).toEqual(saved);
  await expect(
    recheckProductionDatabaseTarget(saved, CONTROL, {
      lookup: resolver(["10.30.0.3"]),
    }),
  ).rejects.toThrow();
});
test("cancellation bounds even a resolver that never replies and conceals private diagnostics", async () => {
  const abort = new AbortController();
  const pending = pinProductionDatabaseTarget(TARGET, CONTROL, {
    lookup: () => new Promise(() => {}),
    signal: abort.signal,
  });
  abort.abort();
  await expect(pending).rejects.toThrow("could not be verified");
  try {
    await pinProductionDatabaseTarget(TARGET, CONTROL, {
      lookup: async () => {
        throw new Error(CONTROL);
      },
    });
  } catch (error) {
    expect(String(error)).not.toContain("private-password");
  }
});
