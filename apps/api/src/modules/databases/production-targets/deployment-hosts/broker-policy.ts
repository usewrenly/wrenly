/** Fixed broker memory mounts keep runtime credentials off persistent storage and inaccessible to generated applications. */
const BROKER_TMPFS = {
  "/run/wrenly-db-config":
    "rw,nosuid,nodev,size=1m,uid=1000,gid=1000,mode=0700",
  "/tmp": "rw,nosuid,nodev,size=1m",
} as const;
/** Docker may reorder mount options; accept the exact option sets, never extra paths or weakened permissions. */
export function assertProductionBrokerMemoryMounts(
  mounts: Record<string, string>,
): void {
  const paths = Object.keys(mounts);
  if (
    paths.length !== Object.keys(BROKER_TMPFS).length ||
    Object.entries(BROKER_TMPFS).some(([path, options]) => {
      const actual = mounts[path];
      return (
        typeof actual !== "string" ||
        actual.split(",").sort().join(",") !==
          options.split(",").sort().join(",")
      );
    })
  )
    throw new Error("Broker private memory mounts changed.");
}
