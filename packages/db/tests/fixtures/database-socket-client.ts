// Trusted acceptance client; bundled by the test and executed only inside a network-disabled container.
import postgres from "postgres";
const serving = process.argv.includes("start");
if (!serving) {
  const input: unknown = await Bun.stdin.json();
  if (
    !input ||
    typeof input !== "object" ||
    !("environment" in input) || !input.environment ||
    typeof input.environment !== "object" || Array.isArray(input.environment)
  )
    throw new Error("Invalid fixture input");
  for (const name of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
    const value = (input.environment as Record<string, unknown>)[name];
    if (typeof value !== "string") throw new Error("Invalid fixture environment");
    process.env[name] = value;
  }
}
// Exercise the application's standard driver settings rather than bypassing them
// with a fixture-only explicit socket path.
const client = postgres({
  max: 1,
  connect_timeout: 3,
});
try {
  await client.begin(async (transaction) => {
    const id = serving ? 4 : 2;
    await transaction`INSERT INTO notes (id, body) VALUES (${id}, 'Postgres.js socket')`;
    const rows = await transaction`SELECT body FROM notes WHERE id = ${id}`;
    if (rows[0]?.body !== "Postgres.js socket")
      throw new Error("Transaction did not persist");
    if (serving) {
      await transaction`UPDATE notes SET body = 'HTTP socket' WHERE id = ${id}`;
      const changed = await transaction`DELETE FROM notes WHERE id = ${id} RETURNING body`;
      if (changed[0]?.body !== "HTTP socket") throw new Error("CRUD verification failed");
      await transaction`INSERT INTO notes (id, body) VALUES (${id}, 'HTTP socket')`;
    }
  });
  for (const address of ["http://169.254.169.254/", "http://1.1.1.1/"]) {
    let reachable = false;
    try {
      await fetch(address, { signal: AbortSignal.timeout(500) });
      reachable = true;
    } catch {
      /* No IP egress is expected. */
    }
    if (reachable) throw new Error("Unexpected IP egress");
  }
  process.stdout.write(
    "Postgres.js prepared transaction and blocked IP egress passed.\n",
  );
} finally {
  await client.end({ timeout: 1 });
}
if (serving) {
  Bun.serve({ hostname: "127.0.0.1", port: 3000, fetch: () => new Response("Database CRUD verified") });
}
