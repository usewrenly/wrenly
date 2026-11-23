/** Docker Compose encodes named volumes in Binds; this does not authorize host paths. */
export function matchesRuntimeVolumeBindings(
  bindings: string[] | null | undefined,
  deploymentId: string,
  service: "application" | "ingress",
): boolean {
  // Docker's structured Mounts API leaves Binds empty; the independent resolved
  // mount checks remain mandatory for either representation.
  if (!bindings?.length) return true;
  const expected = [`wrenly-deployment-http-${deploymentId}:/run/wrenly-http:${service === "application" ? "rw" : "ro"}`];
  if (service === "application") expected.push(`wrenly-deployment-db-${deploymentId}:/run/wrenly-database:ro`);
  return JSON.stringify([...bindings].sort()) === JSON.stringify(expected.sort());
}
