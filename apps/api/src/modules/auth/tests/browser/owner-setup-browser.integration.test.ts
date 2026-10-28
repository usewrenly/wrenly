// Real browser form/entry components; controlled services exercise acknowledgement recovery.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome protected owner setup", () => {
  test("strips operator proof, retries with one identity and confirms sign-in before entering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-owner-browser-"));
    const web = resolve(import.meta.dir, "../../../../../../web");
    const proof = "p".repeat(43);
    const requests: Array<{ proof: string; requestId: string }> = [];
    let bundle = "";
    let statusAvailable = false;
    let result: { ok?: boolean; error?: string } | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        if (url.pathname === "/ready") {
          statusAvailable = true;
          return new Response("ok");
        }
        if (url.pathname === "/report") {
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        if (url.pathname === "/api/instance/setup" && request.method === "GET")
          return statusAvailable
            ? Response.json({ status: "setup-required" })
            : Response.json({ error: "Unavailable" }, { status: 503 });
        if (
          url.pathname === "/api/instance/setup" &&
          request.method === "POST"
        ) {
          const body = (await request.json()) as {
            proof: string;
            requestId: string;
          };
          requests.push(body);
          return requests.length === 1
            ? Response.json({ error: "Acknowledgement lost" }, { status: 503 })
            : Response.json({ created: true, replayed: true }, { status: 201 });
        }
        if (url.pathname === "/api/auth/sign-in/email")
          return Response.json(
            { success: true },
            {
              headers: {
                "Set-Cookie":
                  "fixture-session=confirmed; HttpOnly; Path=/; SameSite=Lax",
              },
            },
          );
        if (url.pathname === "/" || url.pathname === "/get-started")
          return new Response(
            `<script>fetch('/report',{method:'POST',body:JSON.stringify(${request.headers.get("cookie")?.includes("fixture-session=confirmed") ? "{ok:true}" : "{error:'Entered without sign-in cookie'}"})})</script>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        return new Response(
          `<div id="root"></div><script>window.addEventListener('error',event=>fetch('/report',{method:'POST',body:JSON.stringify({error:event.error?.stack??event.message})}));window.addEventListener('unhandledrejection',event=>fetch('/report',{method:'POST',body:JSON.stringify({error:String(event.reason)})}));</script><script src="/bundle.js"></script>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const navigation = join(directory, "navigation.ts");
      await writeFile(
        navigation,
        "export function useRouter(){return {replace(path){window.location.replace(path)}}}",
      );
      const fixture = `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};
        import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};
        import SetupPage from ${JSON.stringify(join(web, "app/(auth)/setup/page.tsx"))};
        createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(SetupPage)));
        const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const until=async check=>{for(let n=0;n<400;n++){if(check())return;await sleep(10)}throw Error('Owner setup timed out')};
        (async()=>{try{
          await until(()=>document.querySelector('[role=alert]'));if(location.hash)throw Error('Proof remained in URL on service failure');if(document.querySelector('form'))throw Error('Service failure opened setup form');
          await fetch('/ready');Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='Try again').click();await until(()=>document.querySelector('#proof')?.value===${JSON.stringify(proof)});
          if(location.hash)throw Error('Setup proof remained in URL');
          document.querySelector('#name').value='Fixture Owner';document.querySelector('#email').value='owner@example.test';if(document.querySelector('#password').minLength!==8)throw Error('Password field policy mismatch');document.querySelector('#password').value='12345678';if(!document.querySelector('#password').checkValidity())throw Error('Eight-character password rejected');
          document.querySelector('form').requestSubmit();await until(()=>document.body.textContent.includes('Acknowledgement lost'));
          await until(()=>!document.querySelector('button[type=submit]').disabled);document.querySelector('form').requestSubmit();
        }catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})})}})();`;
      const entry = join(directory, "fixture.ts");
      await writeFile(entry, fixture);
      const built = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        minify: true,
        define: {
          "process.env.NODE_ENV": '"development"',
          "process.env.NEXT_PUBLIC_DOCS_URL": "undefined",
        },
        plugins: [
          {
            name: "owner-browser-fixture",
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
        throw new Error(
          `Owner browser fixture failed: ${built.logs.map((log) => log.message).join("; ")}`,
        );
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
          `${server.url.origin}/setup#setup=${proof}`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 15_000;
      while (!result && Date.now() < deadline) await Bun.sleep(20);
      expect(result?.error).toBeUndefined();
      expect(result?.ok).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.proof).toBe(proof);
      expect(requests[0]?.requestId).toBe(requests[1]?.requestId);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
