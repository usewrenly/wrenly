/** Real components and authenticated browser transport with controlled data; no application database is queried. */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { connectPage } from "../../../../../../api/src/test-support/chrome-page";

const browserTest = process.env.WRENLY_TEST_DATABASE_BROWSER === "true" ? test : test.skip;
browserTest("database viewer enforces explicit rows, Production confirmation, Viewer controls and stale-response disposal", async () => {
  const web = resolve(import.meta.dir, "../../../../..");
  const directory = await mkdtemp(join(tmpdir(), "wrenly-database-browser-"));
  const project = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  let css = (await readFile(join(web, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "") +
    await readFile(join(web, "components/workspace/databases/database-overview.css"), "utf8");
  if (process.env.WRENLY_TEST_DATABASE_SCREENSHOTS) {
    const built = await Array.fromAsync(new Bun.Glob("*.css").scan({ cwd: join(web, ".next/static/css") }));
    if (!built.length) throw new Error("Build apps/web before styled database captures.");
    css = (await Promise.all(built.map(file => readFile(join(web, ".next/static/css", file), "utf8")))).join("\n") + await readFile(join(web, "components/workspace/databases/database-overview.css"), "utf8");
  }
  let setupPending = false;
  let statusSlow = false, reviewFails = true;
  let bundle = "", owner = true, delay = false, productionConfirmed = false, empty = false, interrupted = false, report: unknown;
  const commands: string[] = [];
  const receipts = new Map<string, { operationId: string; resourceId: string; replayed: boolean }>();
  const reads: Array<{ rows: boolean; owner: boolean; environment: string; delayed: boolean; confirmed: boolean }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/report") { report = await request.json(); return new Response("ok"); }
    if (url.pathname === "/status-slow") { statusSlow = true; return new Response("ok"); }
    if (url.pathname === "/interrupted") { interrupted = true; return new Response("ok"); }
    if (url.pathname === "/empty") { empty = true; return new Response("ok"); }
    if (url.pathname === "/viewer") { owner = false; return new Response("ok"); }
    if (url.pathname === "/owner") { owner = true; return new Response("ok"); }
    if (url.pathname === "/confirm") { productionConfirmed = true; return new Response("ok"); }
    if (url.pathname === "/wait-late") {
      const deadline = Date.now() + 5000;
      while (!reads.some((read) => read.delayed) && Date.now() < deadline) await Bun.sleep(10);
      return new Response("ok", { status: reads.some((read) => read.delayed) ? 200 : 500 });
    }
    if (url.pathname === "/clear-delay") { delay = false; return new Response("ok"); }
    if (url.pathname === "/delay") { delay = true; return new Response("ok"); }
    if (url.pathname.endsWith("/databases")) {
      if (statusSlow) { statusSlow = false; await Bun.sleep(600); }
      const id = url.pathname.split("/")[3]!;
      return Response.json({ capabilities: { manage: owner, developmentRows: owner, productionRows: owner },
        resources: (["development", "production"] as const).filter((environment) => !empty || environment !== "development").map((environment) => ({
          id: `00000000-0000-4000-8000-${String((id === project ? 3 : 5) + (environment === "production" ? 1 : 0)).padStart(12, "0")}`,
          projectId: id, environment, provider: "local", status: setupPending && environment === "development" ? "provisioning" : interrupted && environment === "development" ? "recovery_required" : "ready",
          revision: "00000000-0000-4000-8000-000000000010", schemaDigest: "a".repeat(64), errorCode: null,
          createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
        })), operations: setupPending ? [{ id: "00000000-0000-4000-8000-000000000031", databaseId: `00000000-0000-4000-8000-${String(id === project ? 3 : 5).padStart(12, "0")}`, kind: "create", status: "queued", errorCode: null, createdAt: "2026-10-24T00:00:00.000Z", completedAt: null }] : interrupted ? [{ id: "00000000-0000-4000-8000-000000000030", databaseId: "00000000-0000-4000-8000-000000000005",
          kind: "start", status: "interrupted", errorCode: null, createdAt: "2026-10-24T00:00:00.000Z", completedAt: null }] : [] });
    }
    if (url.pathname.endsWith("/databases/migration-review") && reviewFails) { reviewFails = false; return Response.json({ error: "Review temporarily unavailable" }, { status: 503 }); }
    if (url.pathname.endsWith("/databases/migration-review")) return Response.json({
      projectId: other, resourceId: "00000000-0000-4000-8000-000000000005", revision: "00000000-0000-4000-8000-000000000010",
      buildId: "00000000-0000-4000-8000-000000000020", framework: "laravel", migrationDigest: "b".repeat(64),
      files: [{ path: "database/migrations/notes.php", sha256: "c".repeat(64), content: "<?php // <img src=x onerror=alert(1)>" }],
      backups: [{ id: "00000000-0000-4000-8000-000000000021", verifiedAt: "2026-10-24T00:00:00.000Z", schemaDigest: "a".repeat(64) }] });
    if (url.pathname.endsWith("/databases/recovery-review")) return Response.json({ projectId: other,
      resourceId: "00000000-0000-4000-8000-000000000005", revision: "00000000-0000-4000-8000-000000000010",
      operationId: "00000000-0000-4000-8000-000000000030", choices: ["recover-runtime-state"] });
    if (url.pathname.includes("/databases/actions") || url.pathname.includes("/databases/recovery")) {
      if (!owner) return Response.json({ error: "Forbidden" }, { status: 403 });
      if (request.method === "GET") return Response.json({ acknowledgement: receipts.get(url.pathname.split("/").at(-1)!) ?? null });
      const text = await request.text(); commands.push(text);
      const input = JSON.parse(text) as { requestId: string; kind: string; expectedRevision: string | null };
      const id = url.pathname.split("/")[3];
      const receipt = { operationId: crypto.randomUUID(), resourceId: `00000000-0000-4000-8000-${String(id === project ? 3 : 5).padStart(12, "0")}`, replayed: false };
      if (commands.length === 1) {
        receipts.set(input.requestId, receipt);
        return Response.json({ error: "Lost acknowledgement" }, { status: 503 });
      }
      if (commands.length === 2) return Response.json({ error: "Unconfirmed" }, { status: 503 });
      if (input.kind === "create") { empty = false; setupPending = true; setTimeout(() => { setupPending = false; }, 700); }
      if (input.kind === "recover-runtime-state") interrupted = false;
      receipts.set(input.requestId, receipt);
      return Response.json(receipt, { status: 202 });
    }
    if (url.pathname.endsWith("/databases/view")) {
      const rows = url.searchParams.get("rows") === "true";
      reads.push({ rows, owner, environment: url.searchParams.get("environment") ?? "", delayed: delay && rows, confirmed: productionConfirmed });
      if (rows && !owner) return Response.json({ error: "Forbidden" }, { status: 403 });
      const table = url.searchParams.get("table");
      if (delay && rows) await Bun.sleep(250);
      return Response.json({ tables: ["notes"], table,
        columns: table ? [{ name: "body", type: "text", nullable: true, supported: true, primary: false }] : [],
        rows: rows ? [[delay ? "LATE_PRIVATE_ROW" : "PRIVATE_ROW <img src=x onerror=alert(1)>"]] : [],
        sample: rows, nextKey: null, truncatedColumns: false });
    }
    return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css} *{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:var(--color-bg)}h1,h2,p,dl,dd{margin:0}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}#switch,#actor-switch{position:fixed;opacity:0;pointer-events:none}</style></head><body><div id="root"></div><script>window.addEventListener('error',e=>fetch('/report',{method:'POST',body:JSON.stringify({error:e.message})}));window.addEventListener('unhandledrejection',e=>fetch('/report',{method:'POST',body:JSON.stringify({error:String(e.reason)})}));</script><script type="module" src="/bundle.js"></script></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } });
  } });
  let chrome: Bun.Subprocess | undefined;
  try {
    const config = join(directory, "tsconfig.json"), entry = join(directory, "entry.tsx"), output = join(directory, "out/entry.js");
    await writeFile(config, JSON.stringify({ compilerOptions: { jsx: "react-jsx", paths: {
      "@/*": [web + "/*"], "@tanstack/react-query": [Bun.resolveSync("@tanstack/react-query", web)], react: [web + "/node_modules/react"], "react/*": [web + "/node_modules/react/*"],
    } } }));
    await writeFile(entry, `import * as React from ${JSON.stringify(web + "/node_modules/react")};
import {createRoot} from ${JSON.stringify(web + "/node_modules/react-dom/client")};
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {DatabaseWorkspace} from ${JSON.stringify(web + "/components/workspace/databases/database-workspace.tsx")};
import {DatabaseBuildSelector} from ${JSON.stringify(web + "/components/workspace/databases/database-build-selector.tsx")};
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
function App(){const [successful,setSuccessful]=React.useState(true);const [database,setDatabase]=React.useState(undefined);const [actor,setActor]=React.useState("fixture-user");const [project,setProject]=React.useState(${JSON.stringify(project)});return <QueryClientProvider client={client}><button id="build-result" onClick={()=>setSuccessful(v=>!v)}>Toggle saved build success</button><button id="status-refresh" onClick={()=>void client.refetchQueries({queryKey:["project-databases",actor,project]})}>Refresh fixture</button><button id="actor-switch" onClick={()=>setActor(actor==="fixture-user"?"fixture-other":"fixture-user")}>Switch actor</button><button id="switch" onClick={()=>setProject(${JSON.stringify(other)})}>Switch project</button><DatabaseBuildSelector projectId={project} actorId={actor} value={database} disabled={false} onChange={setDatabase}/><DatabaseWorkspace projectId={project} actorId={actor} selectedBuildSuccessful={successful} selectedBuildId="00000000-0000-4000-8000-000000000020"/></QueryClientProvider>}
createRoot(document.getElementById('root')).render(<App/>);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn)=>{const end=Date.now()+12000;while(Date.now()<end){if(fn())return;await sleep(20)}throw Error('UI state timed out: '+document.body.textContent.slice(-2400))};
const button=text=>Array.from(document.querySelectorAll('button')).find(b=>(b.getAttribute('aria-label')||b.textContent.trim())===text);
(async()=>{try{
 await until(()=>button('No database'));button('No database').click();
 await until(()=>Array.from(document.querySelectorAll('[role=menuitem]')).some(item=>item.textContent.trim()==='Development database'));
 Array.from(document.querySelectorAll('[role=menuitem]')).find(item=>item.textContent.trim()==='Development database').click();
 await until(()=>button('Development database'));await fetch('/status-slow');document.getElementById('status-refresh').click();await sleep(100);if(!button('Development database')||button('Database needs review'))throw Error('Background refresh flickered saved database choice');await sleep(650);button('Development database').click();
 await until(()=>Array.from(document.querySelectorAll('[role=menuitem]')).some(item=>item.textContent.trim()==='No database'));
 Array.from(document.querySelectorAll('[role=menuitem]')).find(item=>item.textContent.trim()==='No database').click();await until(()=>button('No database'));
 await until(()=>button('Browse data'));button('Browse data').click();await until(()=>button('notes'));
 if(document.body.textContent.includes('PRIVATE_ROW'))throw Error('Rows read before table choice');
 button('notes').click();await until(()=>document.body.textContent.includes('PRIVATE_ROW'));
 if(document.querySelector('img'))throw Error('Row text became HTML');
 button('Schema').click();await until(()=>!document.body.textContent.includes('PRIVATE_ROW'));
 await fetch('/viewer',{method:'POST'});button('Database overview').click();await until(()=>button('Inspect schema'));
 if(button('Browse data'))throw Error('Viewer received row navigation');
 button('Inspect schema').click();await until(()=>button('notes'));button('notes').click();await until(()=>document.querySelector('caption')?.textContent==='notes schema');
 if(button('Rows'))throw Error('Viewer received a Rows control');
 await fetch('/owner',{method:'POST'});button('Database overview').click();await until(()=>button('Production'));button('Production').click();await until(()=>button('Inspect schema'));
 button('Inspect schema').click();await until(()=>button('notes'));button('notes').click();await until(()=>document.querySelector('caption')?.textContent==='notes schema');
 button('Rows').click();await until(()=>document.querySelector('[role=dialog]'));if(document.body.textContent.includes('PRIVATE_ROW'))throw Error('Production rows opened before confirmation');
 button('Cancel').click();await until(()=>!document.querySelector('[role=dialog]'));
 button('Rows').click();await until(()=>button('Inspect rows'));await fetch('/confirm',{method:'POST'});button('Inspect rows').click();await until(()=>document.body.textContent.includes('PRIVATE_ROW'));
 button('Schema').click();await until(()=>!document.body.textContent.includes('PRIVATE_ROW'));
 await fetch('/delay',{method:'POST'});button('Rows').click();await until(()=>button('Inspect rows'));button('Inspect rows').click();
 if(!(await fetch('/wait-late')).ok)throw Error('Delayed read did not start');document.getElementById('switch').click();await until(()=>button('Browse data'));await sleep(400);
 if(document.body.textContent.includes('LATE_PRIVATE_ROW')||document.body.textContent.includes('PRIVATE_ROW'))throw Error('A late row crossed project selection');
 button('Manage resource').click();await until(()=>button('Create verified backup'));button('Create verified backup').click();
 await until(()=>button('Confirm backup'));button('Confirm backup').click();await until(()=>button('Check saved action'));
 button('Close').click();await until(()=>button('Review saved request'));
 document.getElementById('actor-switch').click();await until(()=>button('Manage resource')&&!button('Review saved request')&&!document.querySelector('[role=dialog]'));
 document.getElementById('actor-switch').click();await until(()=>button('Check saved action'));
 button('Check saved action').click();await until(()=>document.body.textContent.includes('Database request accepted'));
 button('Manage resource').click();await until(()=>button('Stop database'));button('Stop database').click();await until(()=>button('Confirm stop'));button('Confirm stop').click();
 await until(()=>button('Check saved action'));button('Check saved action').click();await until(()=>document.body.textContent.includes('No saved acknowledgement'));
 button('Retry same request').click();await until(()=>!document.querySelector('[role=dialog]')&&button('Manage resource'));
 await fetch('/empty',{method:'POST'});document.querySelector('[aria-label="Reload database status"]').click();await until(()=>button('Set up Development'));
 button('Set up Development').click();await until(()=>button('Create Development database'));button('Create Development database').click();await until(()=>button('Confirm create'));button('Confirm create').click();
 await until(()=>!document.querySelector('[role=dialog]')&&button('Browse data'));
 await until(()=>!button('Browse data').disabled,'creation must become ready without a manual reload');

 button('Manage resource').click();await until(()=>button('Review database changes'));document.getElementById('build-result').click();await until(()=>button('Review database changes').disabled);if(button('Use this reviewed migration'))throw Error('Failed build opened migration review');document.getElementById('build-result').click();await until(()=>!button('Review database changes').disabled);button('Review database changes').click();await until(()=>button('Reload review'));if(!button('Back to actions'))throw Error('Failed review trapped management controls');button('Reload review').click();
 await until(()=>button('Use this reviewed migration'));
 if(!button('Use this reviewed migration').disabled||button('Confirm migrate'))throw Error('Migration bypassed review');
 document.querySelector('input[type=radio]').click();document.querySelector('input[type=checkbox]').click();
 await until(()=>!button('Use this reviewed migration').disabled);button('Use this reviewed migration').click();await until(()=>button('Confirm migrate'));
 if(document.querySelector('img'))throw Error('Migration text became HTML');
 button('Confirm migrate').click();await until(()=>!document.querySelector('[role=dialog]')&&button('Manage resource'));
 await fetch('/interrupted',{method:'POST'});document.querySelector('[aria-label="Reload database status"]').click();await until(()=>document.body.textContent.includes('Review required'));
 button('Manage resource').click();await until(()=>button('Inspect interrupted start'));button('Inspect interrupted start').click();
 await until(()=>button('Review this recovery action'));if(button('Confirm recovery'))throw Error('Recovery bypassed review');
 button('Review this recovery action').click();await until(()=>button('Confirm recovery'));button('Confirm recovery').click();
 await until(()=>!document.querySelector('[role=dialog]')&&button('Browse data'));
 await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});
}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})})}})();`);
    const build = Bun.spawn([process.execPath, "--no-env-file", "build", entry, "--target=browser",
      "--define", 'process.env.NODE_ENV="production"', "--define", 'process.env.NEXT_PUBLIC_DOCS_URL="http://localhost:3001/docs"', "--tsconfig-override", config, "--outdir", join(directory, "out")],
      { cwd: web, stdout: "ignore", stderr: "pipe" });
    const [code, errors] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    if (code) throw new Error(errors);
    bundle = await readFile(output, "utf8");
    chrome = Bun.spawn([process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome", "--headless=new", "--no-sandbox",
      "--disable-gpu", "--disable-background-networking", "--disable-sync", "--no-first-run", "--remote-debugging-port=0",
      `--user-data-dir=${join(directory, "profile")}`, server.url.href], { stdout: "ignore", stderr: "ignore" });
    const deadline = Date.now() + 25_000;
    while (report === undefined && Date.now() < deadline) await Bun.sleep(25);
    expect(report).toEqual({ ok: true });
    expect(reads[0]?.rows).toBe(false);
    expect(reads.some((read) => read.rows && read.environment === "production")).toBe(true);
    expect(reads.filter((read) => !read.owner).every((read) => !read.rows)).toBe(true);
    expect(reads.filter((read) => read.rows && read.environment === "production").every((read) => read.confirmed)).toBe(true);
    expect(reads.some((read) => read.delayed)).toBe(true);
    expect(commands).toHaveLength(6);
    expect(commands[1]).toBe(commands[2]);
    expect(JSON.parse(commands[0]!).kind).toBe("backup");
    expect(JSON.parse(commands[1]!).kind).toBe("stop");
    expect(JSON.parse(commands[3]!).kind).toBe("create");
    expect(JSON.parse(commands[3]!).expectedRevision).toBeNull();
    expect(JSON.parse(commands[4]!)).toMatchObject({ kind: "migrate", buildId: "00000000-0000-4000-8000-000000000020",
      backupId: "00000000-0000-4000-8000-000000000021", migrationDigest: "b".repeat(64), confirmChanges: true });
    expect(JSON.parse(commands[5]!)).toMatchObject({ kind: "recover-runtime-state", operationId: "00000000-0000-4000-8000-000000000030", confirmRecovery: true });

    const screenshots = process.env.WRENLY_TEST_DATABASE_SCREENSHOTS;
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      const page = await connectPage(join(directory, "profile"));
      try {
        const opened = await page.send("Runtime.evaluate", { awaitPromise: true, returnByValue: true,
          expression: `(async()=>{const button=t=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===t);const until=async fn=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('Viewer not ready');await new Promise(r=>setTimeout(r,20))}};await fetch('/clear-delay');button('Browse data').click();await until(()=>button('notes'));button('notes').click();await until(()=>document.body.textContent.includes('PRIVATE_ROW'));return true})()` });
        if (!opened || typeof opened !== "object" || !("result" in opened) || !opened.result ||
            typeof opened.result !== "object" || !("value" in opened.result) || opened.result.value !== true)
          throw new Error("Viewer screenshot state unavailable");
        for (const [name, width, height, dark] of [["desktop", 1200, 850, false], ["mobile", 390, 844, false], ["dark", 1200, 850, true]] as const) {
          await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
          await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
          const capture = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
          if (!capture || typeof capture !== "object" || !("data" in capture) || typeof capture.data !== "string")
            throw new Error("Viewer screenshot failed");
          await writeFile(join(screenshots, `database-viewer-${name}.png`), Buffer.from(capture.data, "base64"));
        }
        const setup = await page.send("Runtime.evaluate", { awaitPromise: true, returnByValue: true,
          expression: `(async()=>{const button=t=>Array.from(document.querySelectorAll('button')).find(b=>(b.getAttribute('aria-label')||b.textContent.trim())===t);const until=async fn=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('Setup screenshot state unavailable');await new Promise(r=>setTimeout(r,20))}};await fetch('/owner');await fetch('/empty');button('Database overview').click();await until(()=>document.querySelector('[aria-label="Reload database status"]'));document.querySelector('[aria-label="Reload database status"]').click();await until(()=>button('Set up Development'));button('Set up Development').click();await until(()=>document.querySelector('.database-command-choice'));return true})()` });
        if (!setup || typeof setup !== "object" || !("result" in setup) || !setup.result || typeof setup.result !== "object" || !("value" in setup.result) || setup.result.value !== true) throw new Error("Setup screenshot state unavailable");
        for (const [name, width, dark] of [["desktop", 1200, false], ["mobile", 390, false], ["dark", 1200, true]] as const) {
          await page.send("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
          await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
          await page.send("Runtime.evaluate", { expression: `document.documentElement.dataset.theme=${JSON.stringify(dark ? "dark" : "light")}` });
          await Bun.sleep(300);
          const captured = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
          if (!captured || typeof captured !== "object" || !("data" in captured) || typeof captured.data !== "string") throw new Error("Database dialog capture unavailable");
          await writeFile(join(screenshots, `database-setup-${name}.png`), Buffer.from(captured.data, "base64"));
        }
      } finally { page.close(); }
    }

  } finally {
    chrome?.kill(); if (chrome) await chrome.exited;
    await server.stop(true); await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
