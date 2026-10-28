/** Tests a built public handbook with no instance database or external configuration. */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
const acceptance = process.env.WRENLY_TEST_PUBLIC_DOCS === "true" ? test : test.skip;
const READY_ATTEMPTS = 100;
const READY_INTERVAL_MS = 100;
acceptance("public handbook routes, bounded local search and absence of marketing endpoints", async () => {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const app = resolve(import.meta.dir, "../..");
  const child = Bun.spawn(["node", Bun.resolveSync("next/dist/bin/next", app), "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: app, env: process.env, stdout: "ignore", stderr: "ignore" });
  const origin = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < READY_ATTEMPTS; i++) {
      try { ready = (await fetch(origin)).ok; } catch { /* Server is starting. */ }
      if (ready) break;
      await Bun.sleep(READY_INTERVAL_MS);
    }
    expect(ready).toBe(true);
    const home = await fetch(origin, { redirect: "manual" });
    expect(home.status).toBe(307);
    expect(home.headers.get("location")).toBe("/docs");
    for (const path of ["/docs", "/docs/guides/installation", "/docs/architecture/api", "/docs/guides/app-databases"])
      expect((await fetch(origin + path)).status).toBe(200);
    const response = await fetch(origin + "/api/search?query=Skills");
    expect(response.status).toBe(200);
    const results: unknown = await response.json();
    expect(Array.isArray(results) && results.length > 0).toBe(true);
    expect((await fetch(origin + "/api/search?query=" + "x".repeat(201))).status).toBe(400);
    for (const path of ["/api/waitlist", "/api/waitlist/cron", "/waitlist/remove", "/privacy", "/docs/not-a-guide"])
      expect((await fetch(origin + path)).status).toBe(404);
  } finally { child.kill(); await child.exited; }
}, 30_000);
