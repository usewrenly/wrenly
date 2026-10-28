/** Trusted PID 1 keeps migration lifetime bounded even if the API process disappears.
 * The PHP child runs as a different user, so generated code cannot kill its guardian.
 * Credentials flow directly from Docker stdin to PHP; this process never logs them.
 */
const MIGRATION_DEADLINE_MS = 60_000;
const timer = setTimeout(() => process.exit(137), MIGRATION_DEADLINE_MS);
try {
  const child = Bun.spawn(["php", "/wrenly/migrate.php"], {
    cwd: "/app", uid: 1000, gid: 1000,
    stdin: "inherit", stdout: "inherit", stderr: "ignore",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" },
  });
  const code = await child.exited;
  clearTimeout(timer);
  process.exit(code);
} catch {
  clearTimeout(timer);
  process.exit(1);
}
export {};
