// Exercises the real export component with local fixtures and intercepted downloads.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_SOURCE_DOWNLOAD_BROWSER === "true"
    ? describe
    : describe.skip;
integration("source download browser", () => {
  test("one selected ZIP, denied reads, failed source and revision-change cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-export-browser-"));
    const web = resolve(import.meta.dir, "../../../..");
    const id = "f0806312-6585-4b70-9e9b-1e39fd21b017";
    const next = "6c134d8a-e55b-4c75-9592-22abfc800a11";
    const reports = new Map<string, { ok?: boolean; error?: string }>();
    const reads = new Map<string, number>();
    let bundle = "";
    const entry = join(directory, "entry.tsx");
    await writeFile(
      entry,
      `import React,{useState} from ${JSON.stringify(Bun.resolveSync("react", web))};import{createRoot}from ${JSON.stringify(Bun.resolveSync("react-dom/client", web))};import{SourceDownload}from ${JSON.stringify(join(web, "components/workspace/artifacts/source-download.tsx"))};const original=window.fetch.bind(window);const scenario=new URLSearchParams(location.search).get('case');window.fetch=(input,options)=>original(input,typeof input==='string'&&input.startsWith('/api/')?{...options,headers:{...options?.headers,'X-Fixture-Case':scenario}}:options);window.downloads=[];HTMLAnchorElement.prototype.click=function(){window.downloads.push({href:this.href,name:this.download})};function App(){const[id,setId]=useState('${id}');return <><SourceDownload buildId={id} available/><button id="switch" onClick={()=>setId('${next}')}>Switch revision</button></>}createRoot(document.getElementById('root')).render(<App/>);`,
    );
    const compiled = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      jsx: {
        runtime: "automatic",
        importSource: join(web, "node_modules/react"),
      },
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!compiled.success)
      throw new Error("Export browser fixture did not compile.");
    bundle = await compiled.outputs[0]!.text();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "Content-Type": "text/javascript" },
          });
        if (url.pathname === "/report") {
          reports.set(
            url.searchParams.get("case")!,
            (await request.json()) as { ok?: boolean; error?: string },
          );
          return new Response("ok");
        }
        if (url.pathname.startsWith("/api/")) {
          const scenario = request.headers.get("X-Fixture-Case") ?? "";
          reads.set(scenario, (reads.get(scenario) ?? 0) + 1);
          if (scenario === "denied")
            return Response.json({ error: "no access" }, { status: 403 });
          if (scenario === "change") await Bun.sleep(250);
          return Response.json({
            cursor: 1,
            outcome: scenario === "failed" ? "failed" : "success",
            build: {
              id,
              status: scenario === "failed" ? "failed" : "success",
              attemptCount: 1,
              files: [{ path: "app/page.tsx", content: "saved source" }],
              errorMessage: null,
              deployedUrl: null,
              buildLog: "not source",
            },
          });
        }
        return new Response(
          `<!doctype html><html><body><div id="root"></div><script type="module" src="/bundle.js"></script><script type="module">const scenario=new URLSearchParams(location.search).get('case');const wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async(fn)=>{for(let n=0;n<300;n++){if(fn())return;await wait(10)}throw Error('Export fixture timeout')};(async()=>{try{await until(()=>document.querySelector('.workspace-source-download-button'));const button=document.querySelector('.workspace-source-download-button');button.click();if(scenario==='change'){document.querySelector('#switch').click();await wait(600);if(window.downloads.length)throw Error('Changed revision downloaded');}else if(scenario==='denied'){await until(()=>document.querySelector('[role=status]')?.textContent.includes('no longer available'));if(window.downloads.length)throw Error('Denied source downloaded');}else{button.click();await until(()=>window.downloads.length===1);if(window.downloads[0].name!=='wrenly-${id}.zip')throw Error('Wrong revision filename');const bytes=new Uint8Array(await(await fetch(window.downloads[0].href)).arrayBuffer());if(bytes[0]!==80||bytes[1]!==75)throw Error('Invalid archive');if(!document.querySelector('[role=status]').textContent.includes('Download started'))throw Error('Missing download acknowledgement');}await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({ok:true})});}catch(error){await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({error:error.message})})}})();</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    let browser: ReturnType<typeof Bun.spawn> | undefined;
    try {
      for (const scenario of ["success", "failed", "denied", "change"]) {
        browser = Bun.spawn(
          [
            process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--no-first-run",
            "--virtual-time-budget=5000",
            `--user-data-dir=${join(directory, scenario)}`,
            `${server.url.origin}/?case=${scenario}`,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        await browser.exited;
        browser = undefined;
        expect(reports.get(scenario)?.error).toBeUndefined();
        expect(reports.get(scenario)?.ok).toBe(true);
        expect(reads.get(scenario) ?? 0).toBeLessThanOrEqual(1);
      }
    } finally {
      browser?.kill();
      await browser?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
