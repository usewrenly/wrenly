// A tiny driver fixture, not a full generated Next.js application.
import postgres from "postgres";
const client = postgres({ max: 1, connect_timeout: 3 });
await client`INSERT INTO notes (id, body) VALUES (6, 'Live preview database') ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body`;
for (const url of ["http://169.254.169.254/", "http://1.1.1.1/"]) {
  let reachable = false;
  try { await fetch(url, { signal: AbortSignal.timeout(300) }); reachable = true; } catch { /* IP egress must stay blocked. */ }
  if (reachable) process.exit(125);
}
Bun.serve({ hostname: "0.0.0.0", port: 3000, async fetch(): Promise<Response> {
  const rows = await client`SELECT body FROM notes WHERE id = 6`;
  return new Response(`${rows[0]?.body}; uid=${process.getuid?.()}`);
} });
