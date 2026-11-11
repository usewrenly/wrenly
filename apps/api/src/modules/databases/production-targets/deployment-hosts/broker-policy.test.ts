import { expect, test } from "bun:test";
import { assertProductionBrokerMemoryMounts } from "./broker-policy";
const safe = {
  "/run/wrenly-db-config":
    "rw,nosuid,nodev,size=1m,uid=1000,gid=1000,mode=0700",
  "/tmp": "rw,nosuid,nodev,size=1m",
};
test("broker credentials require the exact private memory mounts", () => {
  expect(() => assertProductionBrokerMemoryMounts(safe)).not.toThrow();
  expect(() =>
    assertProductionBrokerMemoryMounts({
      ...safe,
      "/tmp": "nodev,size=1m,rw,nosuid",
    }),
  ).not.toThrow();
  for (const changed of [
    {
      ...safe,
      "/run/wrenly-db-config": safe["/run/wrenly-db-config"].replace(
        "0700",
        "0777",
      ),
    },
    {
      ...safe,
      "/run/wrenly-db-config": safe["/run/wrenly-db-config"].replace(
        "uid=1000",
        "uid=0",
      ),
    },
    { ...safe, "/extra": "rw" },
    { "/tmp": safe["/tmp"] },
  ])
    expect(() => assertProductionBrokerMemoryMounts(changed)).toThrow(
      "private memory mounts changed",
    );
});
