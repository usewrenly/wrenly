/** The real recovery form must keep its proof private and reconcile one uncertain completion. */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
const browserTest =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true" ? test : test.skip;
browserTest(
  "private password recovery strips the fragment and retries the same completion",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-password-browser-"));
    const web = resolve(import.meta.dir, "../../../../../../web"),
      proof = "p".repeat(43);
    let bundle = "",
      report: { ok?: boolean; error?: string } | undefined;
    const submissions: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        if (url.pathname === "/report") {
          report = await request.json();
          return new Response("ok");
        }
        if (url.pathname === "/api/instance/password-recovery") {
          submissions.push(await request.json());
          return submissions.length === 1
            ? Response.json({ error: "Acknowledgement lost" }, { status: 503 })
            : Response.json({ completed: true, replayed: true });
        }
        return new Response(
          '<div id="root"></div><script>window.addEventListener("error",e=>fetch("/report",{method:"POST",body:JSON.stringify({error:e.error?.stack??e.message})}));window.addEventListener("unhandledrejection",e=>fetch("/report",{method:"POST",body:JSON.stringify({error:String(e.reason)})}));</script><script src="/bundle.js"></script>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "fixture.ts");
      await writeFile(
        entry,
        `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};import{createRoot}from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};import{ResetPasswordForm}from ${JSON.stringify(join(web, "app/(auth)/reset-password/reset-password-form.tsx"))};createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(ResetPasswordForm)));const sleep=ms=>new Promise(r=>setTimeout(r,ms));const until=async f=>{for(let i=0;i<500;i++){if(f())return;await sleep(10)}throw Error('Recovery form timeout')};(async()=>{try{await until(()=>document.querySelector('form'));if(location.hash)throw Error('Proof remained in address');document.querySelector('#new-password').value='new-private-password';document.querySelector('#confirm-password').value='new-private-password';document.querySelector('form').requestSubmit();await until(()=>document.body.textContent.includes('Retry same submission'));if(!document.querySelector('#new-password').disabled)throw Error('Uncertain password remained editable');document.querySelector('form').requestSubmit();await until(()=>document.body.textContent.includes('Your password has been reset'));for(const storage of [sessionStorage,localStorage])for(let i=0;i<storage.length;i++){const value=storage.getItem(storage.key(i));if(value?.includes(${JSON.stringify(proof)})||value?.includes('new-private-password'))throw Error('Recovery secret persisted')}await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})})}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})})}})();`,
      );
      const built = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        minify: false,
        define: { "process.env.NODE_ENV": '"development"' },
        plugins: [
          {
            name: "password-recovery-browser",
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
      if (!built.success || !built.outputs[0])
        throw new Error(built.logs.map((log) => log.message).join("; "));
      bundle = await built.outputs[0].text();
      await writeFile(join(directory, "bundle.js"), bundle);
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
          `${server.url.origin}/reset-password#recovery=${proof}`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 15_000;
      while (!report && Date.now() < deadline) await Bun.sleep(20);
      expect(report?.error).toBeUndefined();
      expect(report?.ok).toBe(true);
      expect(submissions).toHaveLength(2);
      expect(submissions[0]).toEqual(submissions[1]);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
