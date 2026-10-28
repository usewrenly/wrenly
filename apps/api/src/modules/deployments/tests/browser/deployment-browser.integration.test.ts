// Real publishing hook with controlled admission loss, remount and revision selection.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_PUBLISHING_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome selected revision publishing", () => {
  test("retains acknowledgement identity across remount and fences late responses from another revision", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-publishing-browser-"),
    );
    const project = crypto.randomUUID();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const id = crypto.randomUUID();
    let bundle = "";
    let requests = 0;
    let visible = false;
    const keys: string[] = [];
    let result: { ok?: boolean; error?: string } | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript" },
          });
        if (url.pathname === "/report") {
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        if (url.pathname === `/api/projects/${project}/deploy`) {
          if (request.method === "POST") {
            requests++;
            keys.push(request.headers.get("Idempotency-Key") ?? "");
            const body = (await request.json()) as { buildId: string };
            if (body.buildId !== a)
              return Response.json(
                { error: "Wrong selected revision" },
                { status: 400 },
              );
            if (requests === 1)
              return Response.json(
                { error: "Acknowledgement lost" },
                { status: 503 },
              );
            visible = true;
            await Bun.sleep(500);
            return Response.json(
              { deploymentId: id, replayed: true },
              { status: 202 },
            );
          }
          return Response.json({
            enabled: true,
            deployment:
              url.searchParams.get("buildId") === a && visible
                ? {
                    id,
                    buildId: a,
                    status: "preparing",
                    url: null,
                    errorCode: null,
                  }
                : null,
          });
        }
        return new Response(
          '<div id="root"></div><script src="/bundle.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const web = resolve(import.meta.dir, "../../../../../../web");
    const fixture = `
      import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};
      import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};
      import {useDeployment} from ${JSON.stringify(join(web, "hooks/use-deployment.ts"))};
      let control;
      function Hook({build}) { const current=useDeployment(${JSON.stringify(project)},build); control=current; return React.createElement('pre',null,JSON.stringify(current.state)); }
      const root=createRoot(document.getElementById('root'));
      const render=(build,key)=>root.render(React.createElement(Hook,{build,key}));
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const until=async check=>{for(let i=0;i<300;i++){if(check())return;await sleep(10)}throw Error('Publishing fixture timed out')};
      (async()=>{try{
        const originalRead=Storage.prototype.getItem, originalWrite=Storage.prototype.setItem;
        Storage.prototype.getItem=function(key){if(key.startsWith('wrenly:publishing:'))throw Error('Blocked storage');return originalRead.call(this,key)};
        render(${JSON.stringify(a)},-2); await until(()=>control&&!control.state.loading); await control.publish();
        await until(()=>control.state.error?.includes('Allow site storage'));
        Storage.prototype.getItem=originalRead;
        Storage.prototype.setItem=function(key,value){if(key.startsWith('wrenly:publishing:'))throw Error('Quota exceeded');return originalWrite.call(this,key,value)};
        render(${JSON.stringify(a)},-1); await until(()=>!control.state.loading&&control.state.error===null); await control.publish();
        await until(()=>control.state.error?.includes('Allow site storage'));
        Storage.prototype.setItem=originalWrite;
        render(${JSON.stringify(a)},1); await until(()=>control&&!control.state.loading&&control.state.error===null);
        await control.publish(); if(control.state.error!=='Acknowledgement lost')await until(()=>control.state.error==='Acknowledgement lost');
        render(${JSON.stringify(a)},2); await until(()=>!control.state.loading&&control.state.error===null);
        const pending=control.publish(); await sleep(100); render(${JSON.stringify(b)},3);
        await until(()=>control.state.buildId===${JSON.stringify(b)}&&!control.state.loading);
        await pending; await sleep(600);
        if(control.state.deployment!==null)throw Error('Late A acknowledgement replaced B');
        render(${JSON.stringify(a)},4); await until(()=>control.state.deployment?.status==='preparing');
        if(control.state.deployment.id!==${JSON.stringify(id)})throw Error('Accepted publishing status did not recover');
        await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});
      }catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})})}})();`;
    const entry = join(directory, "fixture.ts");
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await writeFile(entry, fixture);
      const output = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        minify: true,
        define: {
          "process.env.NODE_ENV": '"production"',
          "process.env.NEXT_PUBLIC_DOCS_URL": "undefined",
        },
        plugins: [
          {
            name: "publishing-fixture-resolution",
            setup(build) {
              build.onResolve({ filter: /^@\// }, (args) => ({
                path: Bun.resolveSync(resolve(web, args.path.slice(2)), web),
              }));
              build.onResolve({ filter: /^[^./]/ }, (args) => {
                try {
                  return {
                    path: Bun.resolveSync(args.path, dirname(args.importer)),
                  };
                } catch {
                  return { path: Bun.resolveSync(args.path, web) };
                }
              });
            },
          },
        ],
      });
      if (!output.success || !output.outputs[0])
        throw new Error("Publishing browser fixture could not bundle.");
      bundle = await output.outputs[0].text();
      chrome = Bun.spawn(
        [
          process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
          "--headless=new",
          "--disable-gpu",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          server.url.href,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 15_000;
      while (!result && Date.now() < deadline) await Bun.sleep(20);
      expect(result?.error).toBeUndefined();
      expect(result?.ok).toBe(true);
      expect(requests).toBe(2);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
