/** Real browser controls against a disposable HTTP fixture; no external server or credentials are used. */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const browserTest =
  process.env.WRENLY_TEST_DATABASE_BROWSER === "true" ? test : test.skip;
browserTest(
  "owner server setup follows saved requests without retaining credentials or repeating a write",
  async () => {
    const web = resolve(import.meta.dir, "../../../../../");
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-production-setup-browser-"),
    );
    let bundle = "",
      report: unknown,
      submissions = 0,
      reads = 0;
    let saved: { requestId: string; target: unknown } | null = null;
    const connectionId = crypto.randomUUID();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        if (path === "/report") {
          report = await request.json();
          return new Response("ok");
        }
        if (path.startsWith("/api/instance/production-database")) {
          if (request.method === "POST") {
            submissions++;
            const body: unknown = await request.json();
            if (
              !body ||
              typeof body !== "object" ||
              !("requestId" in body) ||
              typeof body.requestId !== "string" ||
              !("target" in body)
            )
              return new Response(null, { status: 400 });
            saved = { requestId: body.requestId, target: body.target };
            // Simulate persistence succeeding while the reply is lost.
            return Response.json({ error: "uncertain" }, { status: 503 });
          }
          reads++;
          return Response.json(
            saved
              ? {
                  connectionId,
                  status: "verified",
                  target: saved.target,
                  verified: {
                    clusterId: "12345",
                    database: "postgres",
                    setupRole: "manager",
                    serverVersion: 170001,
                  },
                }
              : null,
          );
        }
        return new Response(
          '<div id="root"></div><script>window.addEventListener("error",e=>fetch("/report",{method:"POST",body:JSON.stringify({error:e.error?.stack||e.message})}));</script><script src="/bundle.js"></script>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const config = join(directory, "tsconfig.json"),
        entry = join(directory, "entry.tsx");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            baseUrl: web,
            paths: {
              "@/*": [web + "/*"],
              react: [web + "/node_modules/react"],
              "react/*": [web + "/node_modules/react/*"],
            },
          },
        }),
      );
      await writeFile(
        entry,
        `
import React from ${JSON.stringify(join(web, "node_modules/react"))};
import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client"))};
import {ProductionServerSetup} from ${JSON.stringify(join(web, "components/settings/production-databases/production-server-setup"))};
createRoot(document.getElementById('root')).render(<ProductionServerSetup actorId="fixture-owner"/>);
(async()=>{try{
const until=async fn=>{const end=Date.now()+7000;while(!fn()){if(Date.now()>end)throw Error('UI deadline');await new Promise(r=>setTimeout(r,20));}};
const button=text=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===text);
await until(()=>document.querySelector('form'));
if(sessionStorage.length)throw Error('Initial read stored a request');
for(const [name,value]of Object.entries({host:'apps.internal.test',port:'5432',database:'postgres',user:'manager',password:'fixture-private-password'}))document.querySelector('[name='+name+']').value=value;
document.querySelector('[name=confirm]').checked=true;
document.querySelector('form').requestSubmit();
await until(()=>document.querySelector('[role=alert]'));
const stored=Object.values(sessionStorage).join(' ');
if(stored.includes('fixture-private-password')||stored.includes('apps.internal.test')||stored.includes('manager'))throw Error('Setup secret or target entered browser storage');
if(!stored)throw Error('Lost reply discarded saved identity');
button('Check saved status').click();
await until(()=>document.body.textContent.includes('Connection: verified'));
if(sessionStorage.length)throw Error('Acknowledged request was not cleared');
await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});
}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})});}})();`,
      );
      const build = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          entry,
          "--target=browser",
          "--define",
          'process.env.NODE_ENV="production"',
          "--tsconfig-override",
          config,
          "--outdir",
          join(directory, "out"),
        ],
        { cwd: web, stdout: "ignore", stderr: "pipe" },
      );
      const [code, errors] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ]);
      if (code) throw new Error(errors);
      bundle = await readFile(join(directory, "out/entry.js"), "utf8");
      chrome = Bun.spawn(
        [
          process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-background-networking",
          "--disable-sync",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          server.url.href,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 20000;
      while (report === undefined && Date.now() < deadline) await Bun.sleep(25);
      expect(report).toEqual({ ok: true });
      expect(submissions).toBe(1);
      expect(reads).toBeGreaterThanOrEqual(2);
    } finally {
      chrome?.kill();
      if (chrome) await chrome.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
