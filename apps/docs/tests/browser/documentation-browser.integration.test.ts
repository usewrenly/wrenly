// Exercise built routes/search and browser UI without an instance DB.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_DOCS_BROWSER === "true" ? describe : describe.skip;
integration("public Fumadocs site", () => {
  test("compiled guides,404, local search, navigation and responsive isolated styles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-docs-browser-"));
    const captures = process.env.WRENLY_TEST_ENTRY_SCREENSHOTS
      ? resolve(process.env.WRENLY_TEST_ENTRY_SCREENSHOTS)
      : directory;
    if (!captures.startsWith("/tmp/")) throw Error("Use /tmp for screenshots");
    await mkdir(captures, { recursive: true });
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserved"),
    });
    const port = reservation.port!;
    await reservation.stop(true);
    const app = resolve(import.meta.dir, "../..");
    const next = Bun.spawn(
      [
        "node",
        Bun.resolveSync("next/dist/bin/next", app),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: app,
        env: { ...process.env },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const origin = `http://127.0.0.1:${port}`;
    const reports = new Map<string, { ok?: boolean; error?: string }>();
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    const script = `<script type="module">
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const scenario=new URLSearchParams(location.search).get('case');const until=async(fn,label)=>{for(let i=0;i<500;i++){if(fn())return;await sleep(10)}throw Error('Timeout '+label+' '+(document.querySelector('[role=dialog]')?.innerText||''))};
(async()=>{try{await document.fonts.ready;await sleep(600);const theme=scenario.includes('dark')?'dark':'light';localStorage.setItem('theme',theme);window.dispatchEvent(new StorageEvent('storage',{key:'theme',newValue:theme}));await until(()=>document.documentElement.classList.contains('dark')===(theme==='dark'),'theme');if(!document.querySelector('#nd-docs-layout'))throw Error('Docs not rendered');if(scenario.includes('architecture')){if(!document.querySelector('figure[aria-label="Wrenly system architecture"]'))throw Error('Architecture diagram missing');}else if(scenario.includes('databases')){if(!document.body.innerText.includes('Experimental · Development only'))throw Error('Database status missing');}else{if(!document.body.innerText.includes('A revision is a saved version'))throw Error('Overview not rendered');if(document.querySelectorAll('[data-card]').length<6)throw Error('Task cards missing');}if(!document.querySelector('button[aria-controls]')&&innerWidth<768)throw Error('Menu trigger missing');if(document.querySelectorAll('.docs-top-navigation a').length!==3)throw Error('Top navigation missing');if(innerWidth<768){const menu=document.querySelector('button[aria-label="Open documentation navigation"]');if(!menu||menu.getBoundingClientRect().width===0)throw Error('Mobile navigation unavailable');menu.click();await until(()=>document.querySelector('#nd-sidebar-mobile[data-state=open]'),'mobile menu open');menu.click();await until(()=>!document.querySelector('#nd-sidebar-mobile[data-state=open]'),'mobile menu closed');}if(!scenario.includes('architecture')&&!scenario.includes('databases')&&innerWidth>=768){const group=Array.from(document.querySelectorAll('#nd-sidebar button')).find(node=>node.textContent.trim()==='Workspace');if(!group)throw Error('Collapsible section missing');const before=group.getAttribute('aria-expanded');group.click();await until(()=>group.getAttribute('aria-expanded')!==before,'section toggle');group.click();await until(()=>group.getAttribute('aria-expanded')===before,'section restore');}if(document.body.innerText.includes('design-map/'))throw Error('Developer files exposed');if(document.documentElement.scrollWidth>innerWidth)throw Error('Horizontal overflow '+JSON.stringify({viewport:innerWidth,scroll:document.documentElement.scrollWidth,items:Array.from(document.querySelectorAll('body *')).filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,6).map(e=>({tag:e.tagName,id:e.id,classes:typeof e.className==='string'?e.className:'svg',right:e.getBoundingClientRect().right}))}));
const search=Array.from(document.querySelectorAll('button')).find(b=>(b.getAttribute('aria-label')||'').includes('Search')||b.textContent.includes('Search'));if(!search)throw Error('Search trigger missing');search.click();await until(()=>document.querySelector('[role=dialog] input'),'search dialog');const input=document.querySelector('[role=dialog] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Skills');input.dispatchEvent(new Event('input',{bubbles:true}));await until(()=>Array.from(document.querySelectorAll('[role=dialog] [role=option]')).some(item=>item.textContent.includes('Skills')),'local Skills result');document.querySelector('[role=dialog] button[aria-label="Close Search"]').click();document.getAnimations().forEach(animation=>animation.finish());await until(()=>!document.querySelector('[role=dialog][data-state=open]'),'search closed');await sleep(400);document.getAnimations().forEach(animation=>animation.finish());await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({ok:true})});}catch(error){await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({error:error.message})})}})();</script>`;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/report") {
          reports.set(
            url.searchParams.get("case")!,
            (await request.json()) as { ok?: boolean; error?: string },
          );
          return new Response("ok");
        }
        if (
          request.method !== "GET" ||
          (url.pathname.startsWith("/api/") && url.pathname !== "/api/search")
        )
          return new Response("Unexpected operation", { status: 400 });
        const response = await fetch(origin + url.pathname + url.search);
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        if (headers.get("content-type")?.includes("text/html"))
          return new Response(
            (await response.text()).replace("</body>", script + "</body>"),
            { status: response.status, headers },
          );
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      },
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 150 && !ready; attempt++) {
        try {
          ready = (await fetch(origin + "/docs")).ok;
        } catch {}
        if (!ready) await Bun.sleep(100);
      }
      expect(ready).toBe(true);
      for (const path of [
        "/docs",
        "/docs/guides/instance-setup",
        "/docs/guides/local-previews",
        "/docs/guides/private-publishing",
        "/docs/guides/publishing-setup",
        "/docs/reference/publishing-operations",
        "/docs/architecture/overview",
        "/docs/architecture/project-structure",
        "/docs/why-wrenly",
        "/docs/roadmap",
        "/docs/guides/app-databases",
        "/docs/reference/http",
      ])
        expect((await fetch(origin + path)).status).toBe(200);
      expect((await fetch(origin + "/docs/not-a-guide")).status).toBe(404);
      const publishing = await (
        await fetch(origin + "/docs/guides/private-publishing")
      ).text();
      expect(publishing).toContain(
        'aria-label="Saved revision to deployment flow"',
      );
      expect(publishing).toContain("/screenshots/workspace-preview.png");
      expect(
        (await fetch(origin + "/screenshots/workspace-preview.png")).status,
      ).toBe(200);
      const architecture = await (
        await fetch(origin + "/docs/architecture/overview")
      ).text();
      expect(architecture).toContain('aria-label="Wrenly system architecture"');
      const databases = await (
        await fetch(origin + "/docs/guides/app-databases")
      ).text();
      expect(databases).toContain("Experimental · Development only");
      expect(databases).not.toContain("Launch waitlist");
      expect((await fetch(origin + "/docs/guides/launch-hosting")).status).toBe(
        404,
      );
      expect(
        (await fetch(origin + "/docs/guides/launch-waitlist")).status,
      ).toBe(404);
      expect(
        await (await fetch(origin + "/api/search?query=waitlist")).text(),
      ).not.toContain("launch-waitlist");
      const result = await fetch(origin + "/api/search?query=Skills");
      expect(result.status).toBe(200);
      expect(await result.text()).toContain("/docs/guides/skills");
      expect(
        (await fetch(origin + "/api/search?query=" + "x".repeat(201))).status,
      ).toBe(400);
      for (const [scenario, width] of [
        ["docs-desktop", 1440],
        ["docs-mobile", 390],
        ["docs-dark", 1440],
        ["docs-architecture", 1440],
        ["docs-architecture-mobile", 390],
        ["docs-databases-dark", 1440],
      ] as const) {
        chrome = Bun.spawn(
          [
            process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--no-first-run",
            "--hide-scrollbars",
            "--virtual-time-budget=10000",
            ...(scenario.includes("dark") ? ["--force-dark-mode"] : []),
            `--user-data-dir=${join(directory, scenario)}`,
            `--window-size=${width},1000`,
            `--screenshot=${join(captures, scenario + ".png")}`,
            `${proxy.url.origin}${scenario.includes("architecture") ? "/docs/architecture/overview" : scenario.includes("databases") ? "/docs/guides/app-databases" : "/docs"}?case=${scenario}`,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        await chrome.exited;
        chrome = undefined;
        expect(reports.get(scenario)?.error, scenario).toBeUndefined();
        expect(reports.get(scenario)?.ok).toBe(true);
      }
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await proxy.stop(true);
      next.kill();
      await next.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }, 90000);
});
