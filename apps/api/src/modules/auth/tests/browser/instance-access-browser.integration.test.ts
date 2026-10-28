// Actual AuthGuard with controlled access responses and a navigation adapter.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome instance access guard", () => {
  test("authenticated single-owner access, multi-user redirect, failure retry and stale response fencing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-instance-browser-"));
    const web = resolve(import.meta.dir, "../../../../../../web");
    let mode = "local";
    let bundle = "";
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
        if (url.pathname === "/scenario") {
          mode = url.searchParams.get("mode")!;
          return new Response("ok");
        }
        if (url.pathname === "/report") {
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        if (url.pathname === "/api/instance/access") {
          const selected = mode;
          if (selected === "slow-local") await Bun.sleep(500);
          if (selected === "error")
            return Response.json({ error: "Unavailable" }, { status: 503 });
          return Response.json(
            selected === "local" || selected === "slow-local"
              ? { mode: "single-user", access: "authenticated" }
              : {
                  mode: "multi-user",
                  access:
                    selected === "authenticated"
                      ? "authenticated"
                      : "sign-in-required",
                },
          );
        }
        return new Response(
          '<div id="root"></div><script src="/bundle.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const navigation = join(directory, "navigation.ts");
      await writeFile(
        navigation,
        "const router={replace(path){globalThis.fixtureRoute=path}};export function useRouter(){return router}",
      );
      const fixture = `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};
        import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};
        import {AuthGuard} from ${JSON.stringify(join(web, "components/auth/auth-guard.tsx"))};
        const root=createRoot(document.getElementById('root'));let key=0;
        const render=()=>root.render(React.createElement(AuthGuard,{key:++key},React.createElement('p',{id:'protected'},'Workspace')));
        const sleep=ms=>new Promise(r=>setTimeout(r,ms));
        const until=async check=>{for(let n=0;n<300;n++){if(check())return;await sleep(10)}throw Error('Access guard timed out')};
        const scenario=async mode=>{await fetch('/scenario?mode='+mode);globalThis.fixtureRoute=null;render()};
        (async()=>{try{
          await scenario('local');await until(()=>document.querySelector('[role=status] .wrenly-wing-motion'));
          const loadingStarted=performance.now();await sleep(250);
          if(document.querySelector('#protected'))throw Error('Workspace flashed past the loading state');
          await until(()=>document.querySelector('#protected'));
          if(performance.now()-loadingStarted<1000)throw Error('Minimum loading presentation was skipped');
          if(globalThis.fixtureRoute)throw Error('Authenticated owner redirected');
          await scenario('authenticated');await sleep(50);await until(()=>document.querySelector('#protected'));
          await scenario('denied');await until(()=>globalThis.fixtureRoute==='/sign-in');
          if(document.querySelector('#protected'))throw Error('Unauthenticated workspace rendered');
          await scenario('error');await until(()=>document.querySelector('[role=alert]'));
          if(globalThis.fixtureRoute||document.querySelector('#protected'))throw Error('Service error granted access or redirected');
          await fetch('/scenario?mode=local');document.querySelector('button').click();await until(()=>document.querySelector('#protected'));
          await scenario('slow-local');await sleep(70);await scenario('denied');await until(()=>globalThis.fixtureRoute==='/sign-in');
          await sleep(600);if(document.querySelector('#protected'))throw Error('Stale local response granted access');
          await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});
        }catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})})}})();`;
      const entry = join(directory, "fixture.ts");
      await writeFile(entry, fixture);
      const built = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        minify: true,
        define: {
          "process.env.NODE_ENV": '"production"',
          "process.env.NEXT_PUBLIC_DOCS_URL": "undefined",
        },
        plugins: [
          {
            name: "instance-browser-fixture",
            setup(build) {
              build.onResolve({ filter: /^next\/navigation$/ }, () => ({
                path: navigation,
              }));
              build.onResolve({ filter: /^@\// }, (args) => ({
                path: Bun.resolveSync(resolve(web, args.path.slice(2)), web),
              }));
              build.onResolve({ filter: /^[^./]/ }, (args) => {
                if (args.path === "next/navigation")
                  return { path: navigation };
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
      if (!built.success || !built.outputs[0])
        throw new Error("Instance browser fixture could not bundle.");
      bundle = await built.outputs[0].text();
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
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
