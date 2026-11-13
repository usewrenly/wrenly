/** Real owner dialog with a controlled lost reply; no provider or instance database participates. */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const check =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true" ? test : test.skip;
check(
  "maintenance dialog preserves a lost decision across remount and checks its receipt without resending",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-maintenance-browser-"),
    );
    const web = resolve(import.meta.dir, "../../../../../../web");
    const project = crypto.randomUUID(),
      deployment = crypto.randomUUID(),
      revision = crypto.randomUUID();
    let bundle = "",
      writes = 0,
      reads = 0,
      stored: { requestId: string; state: string } | null = null;
    let report: { ok?: boolean; error?: string } | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript" },
          });
        if (url.pathname === "/report") {
          report = (await request.json()) as typeof report;
          return new Response("ok");
        }
        if (url.pathname.startsWith("/api/")) {
          if (request.method === "POST") {
            writes++;
            stored = (await request.json()) as typeof stored;
            return Response.json({ error: "reply lost" }, { status: 503 });
          }
          if (url.pathname.includes("/actions/")) {
            reads++;
            return Response.json({
              requestId: stored!.requestId,
              grantRevision: revision,
              state: stored!.state,
              replayed: true,
            });
          }
          return Response.json({
            accessRevision: revision,
            grantRevision: stored ? revision : null,
            state: stored?.state ?? "disabled",
            attempt: null,
          });
        }
        return new Response(
          '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/bundle.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "entry.tsx"),
        auth = join(directory, "auth.ts"),
        config = join(directory, "tsconfig.json"),
        output = join(directory, "bundle.js");
      await writeFile(
        auth,
        'export const authClient={useSession:()=>({data:{user:{id:"fixture-owner"}}})};',
      );
      await writeFile(
        entry,
        `
import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};
import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};
import {QueryClient,QueryClientProvider} from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};
import {MaintenanceControls} from ${JSON.stringify(join(web, "features/deployments/maintenance-controls.tsx"))};
const root=createRoot(document.getElementById('root')), client=new QueryClient({defaultOptions:{queries:{retry:false}}});
function mount(){root.render(React.createElement(QueryClientProvider,{client},React.createElement(MaintenanceControls,{projectId:${JSON.stringify(project)},deploymentId:${JSON.stringify(deployment)}})));}
const until=async check=>{for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}throw Error('Did not settle: '+document.body.textContent);};
const button=text=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent===text);
(async()=>{try{
mount();await until(()=>button('Runtime maintenance'));button('Runtime maintenance').click();
await until(()=>button('Enable maintenance'));button('Enable maintenance').click();await until(()=>button('Confirm maintenance'));button('Confirm maintenance').click();
await until(()=>document.body.textContent.includes('decision could not be confirmed'));
const key=${JSON.stringify(`wrenly:maintenance:fixture-owner:${project}:${deployment}`)};
const original=localStorage.getItem(key);if(!original)throw Error('Pending decision lost');
root.render(null);await new Promise(r=>setTimeout(r,50));mount();await until(()=>button('Runtime maintenance'));button('Runtime maintenance').click();
await until(()=>button('Check saved decision'));if(button('Pause maintenance'))throw Error('Unconfirmed decision allowed another write');
if(localStorage.getItem(key)!==original)throw Error('Identity changed on remount');button('Check saved decision').click();
await until(()=>document.body.textContent.includes('Permission saved.'));if(localStorage.getItem(key))throw Error('Confirmed receipt did not clear pending decision');
await until(()=>button('Pause maintenance'));
await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});
}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})});}})();`,
      );
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            paths: {
              "@/*": [web + "/*"],
              "@/lib/auth/auth-client": [auth],
              "@tanstack/react-query": [
                Bun.resolveSync("@tanstack/react-query", web),
              ],
            },
          },
        }),
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
          "--outfile",
          output,
        ],
        { cwd: web, stdout: "ignore", stderr: "pipe" },
      );
      const [code, diagnostic] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ]);
      if (code) throw new Error(diagnostic);
      bundle = await readFile(output, "utf8");
      chrome = Bun.spawn(
        [
          process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
          "--headless=new",
          "--disable-gpu",
          "--disable-background-networking",
          "--no-first-run",
          `--user-data-dir=${join(directory, "chrome")}`,
          "--window-size=1280,900",
          server.url.href,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 20000;
      while (!report && Date.now() < deadline) await Bun.sleep(30);
      expect(report).toEqual({ ok: true });
      expect(writes).toBe(1);
      expect(reads).toBe(1);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
