// Exercises the real Connections/history pages with controlled read responses;
// the fixture never starts publishing or connects to a remote provider.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const suite =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
suite("Chrome connections and deployment history", () => {
  test("truthful planned connections, history errors, pagination, revocation and responsive layout without mutations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-connections-"));
    const web = resolve(import.meta.dir, "../../../../../../web");
    const css = (
      await Promise.all(
        (
          await Array.fromAsync(
            new Bun.Glob("*.css").scan({ cwd: join(web, ".next/static/css") }),
          )
        ).map((file) => readFile(join(web, ".next/static/css", file), "utf8")),
      )
    ).join("\n");
    let bundle = "",
      scenario = "",
      revoked = false,
      failed = false,
      mutations = 0;
    const project = crypto.randomUUID(),
      buildId = crypto.randomUUID();
    const results = new Map<string, { ok?: boolean; error?: string }>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript" },
          });
        if (url.pathname === "/style.css")
          return new Response(css, { headers: { "content-type": "text/css" } });
        if (url.pathname === "/report") {
          results.set(
            scenario,
            (await request.json()) as { ok?: boolean; error?: string },
          );
          return new Response("ok");
        }
        if (url.pathname === "/revoke") {
          revoked = true;
          return new Response("ok");
        }
        if (url.pathname.startsWith("/api/")) {
          if (request.method !== "GET") mutations++;
          if (url.pathname === "/api/instance/setup-summary")
            return Response.json({
              role: "owner",
              accountConfigured: true,
              providerConfigured: true,
              hasProjects: true,
              defaultModel: {
                state: "configured",
                modelId: "fixture",
                providerLabel: "fixture",
                source: "saved",
              },
              preview: "enabled",
              publishing: scenario.includes("disabled")
                ? "operator-setup"
                : "enabled",
              connectionHealth: "not-checked",
            });
          if (url.pathname === "/api/deployments") {
            if (scenario === "history-error" && !failed) {
              failed = true;
              return Response.json(
                { error: "Fixture unavailable" },
                { status: 503 },
              );
            }
            const offset = Number(url.searchParams.get("offset") ?? 0);
            return Response.json({
              deployments:
                revoked || scenario === "history-empty"
                  ? []
                  : [
                      {
                        id: crypto.randomUUID(),
                        projectId: project,
                        projectName: "Shared Laravel workspace",
                        buildId,
                        stack: "laravel",
                        status: offset ? "interrupted" : "success",
                        createdAt: new Date().toISOString(),
                        url: offset ? null : "https://published.fixture.test",
                      },
                    ],
              nextOffset:
                offset || revoked || scenario === "history-empty" ? null : 24,
            });
          }
          return Response.json(
            { error: "Unexpected fixture request" },
            { status: 404 },
          );
        }
        return new Response(
          '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/bundle.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "fixture.tsx"),
        link = join(directory, "link.tsx");
      await writeFile(
        link,
        "import React from " +
          JSON.stringify(join(web, "node_modules/react/index.js")) +
          ";export default function Link(props){return React.createElement('a',props);}",
      );
      await writeFile(
        entry,
        `
import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};
import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};
import {QueryClient,QueryClientProvider} from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};
import Connections from ${JSON.stringify(join(web, "app/(app)/settings/connections/page.tsx"))};
import History from ${JSON.stringify(join(web, "app/(app)/projects/deployments/page.tsx"))};
const scenario=new URLSearchParams(location.search).get('case');
window.addEventListener("error",event=>fetch("/report",{method:"POST",body:JSON.stringify({error:event.error?.stack??event.message})}));
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
if(scenario.includes('dark'))document.documentElement.dataset.theme='dark';
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(scenario.startsWith('connections')?Connections:History)));

const until=async check=>{for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}throw Error('Page did not settle: '+document.body.textContent.slice(0,800));};
const button=text=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent===text);
(async()=>{try{
if(scenario.startsWith('connections')){
 await until(()=>document.body.textContent.includes(scenario.includes('disabled')?'Not configured':'Publishing enabled'));
 if(document.querySelectorAll('.connection-state').length!==5||document.querySelectorAll('.connection-state')[1].textContent!=='Planned')throw Error('Planned connectors appear available');
 if(document.querySelector('button')||!document.querySelector('a[href="/projects/deployments"]'))throw Error('Connections invented activation controls');
}else{
 if(scenario==='history-error'){await until(()=>button('Try again'));button('Try again').click();}
 if(scenario==='history-empty'){await until(()=>document.body.textContent.includes('Nothing published yet'));}
 else{
 await until(()=>document.querySelector('.deployment-history-row'));
 if(scenario.includes('disabled'))await until(()=>document.body.textContent.includes('New publishing is disabled'));
 const link=document.querySelector('.deployment-project');if(!link.href.includes('?build=${buildId}'))throw Error('Selected revision lost');
 if(!document.querySelector('a[href="https://published.fixture.test/"]'))throw Error('Safe application link missing');
 button('Next').click();await until(()=>document.querySelector('.deployment-attention'));
 if(document.querySelector('a[href="https://published.fixture.test/"]'))throw Error('Old page application leaked');
 button('Previous').click();await until(()=>document.querySelector('a[href="https://published.fixture.test/"]'));
 await fetch('/revoke');await client.invalidateQueries({queryKey:['deployment-history']});await until(()=>!document.querySelector('.deployment-history-row'));
 }
}
if(document.documentElement.scrollWidth>innerWidth+2)throw Error('Horizontal overflow');
await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});
}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})});}})();`,
      );
      const config = join(directory, "tsconfig.json"),
        output = join(directory, "bundle.js");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            paths: {
              "@/*": [web + "/*"],
              "next/link": [link],
              "@tanstack/react-query": [
                Bun.resolveSync("@tanstack/react-query", web),
              ],
            },
          },
        }),
      );
      const built = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          entry,
          "--target=browser",
          "--define",
          'process.env.NODE_ENV="production"',
          "--define",
          "process.env.NEXT_PUBLIC_DOCS_URL=undefined",
          "--tsconfig-override",
          config,
          "--outfile",
          output,
        ],
        { cwd: web, stdout: "ignore", stderr: "pipe" },
      );
      const [code, diagnostic] = await Promise.all([
        built.exited,
        new Response(built.stderr).text(),
      ]);
      if (code) throw new Error(diagnostic);
      bundle = await readFile(output, "utf8");
      for (const [name, width] of [
        ["connections", 1440],
        ["connections-disabled", 390],
        ["connections-dark", 768],
        ["history", 1440],
        ["history-phone", 320],
        ["history-disabled", 390],
        ["history-error", 768],
        ["history-empty", 390],
      ] as const) {
        scenario = name;
        revoked = false;
        failed = false;
        chrome = Bun.spawn(
          [
            process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--no-first-run",
            `--user-data-dir=${join(directory, name)}`,
            `--window-size=${width},1000`,
            `${server.url.origin}/?case=${name}`,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        const deadline = Date.now() + 15000;
        while (!results.has(name) && Date.now() < deadline) await Bun.sleep(30);
        chrome.kill();
        await chrome.exited;
        chrome = undefined;
        expect({ scenario: name, error: results.get(name)?.error }).toEqual({
          scenario: name,
          error: undefined,
        });
        expect(results.get(name)?.ok).toBe(true);
      }
      expect(mutations).toBe(0);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});
