/** Real browser and React components; controlled replies test presentation, never actual provisioning. */
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const enabled = process.env.WRENLY_TEST_PREVIEW_BROWSER === "true";
(enabled ? test : test.skip)(
  "inline database approval, migration review and completion survive page reload",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-chat-database-browser-"),
    );
    const web = resolve(import.meta.dir, "../../../../../../web");
    const id = crypto.randomUUID(),
      turnId = crypto.randomUUID(),
      project = crypto.randomUUID(),
      build = crypto.randomUUID();
    let phase = "proposed",
      bundle = "",
      posts = 0,
      report: { ok?: boolean; error?: string } | undefined;
    const result = (): unknown => ({
      canManage: true,
      workflows: [
        {
          id,
          turnId,
          revision: id,
          state: phase,
          purpose: "Persistent notes",
          resourceId: null,
          buildId: phase === "proposed" ? null : build,
          error: null,
          files:
            phase === "review"
              ? [
                  {
                    path: "drizzle/0000_notes.sql",
                    sha256: "a".repeat(64),
                    content: "CREATE TABLE notes(id integer PRIMARY KEY);",
                  },
                ]
              : [],
        },
      ],
    });
    const css = (
      await Promise.all(
        (
          await Array.fromAsync(
            new Bun.Glob("**/*.css").scan({ cwd: join(web, ".next/static") }),
          )
        ).map((path) => readFile(join(web, ".next/static", path), "utf8")),
      )
    ).join("\n");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/fixture.js")
          return new Response(bundle, {
            headers: { "Content-Type": "text/javascript" },
          });
        if (path === "/style.css")
          return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (path === "/report") {
          report = (await request.json()) as typeof report;
          return new Response("ok");
        }
        if (path === "/review") {
          phase = "review";
          return new Response("ok");
        }
        if (path === "/complete") {
          phase = "complete";
          return new Response("ok");
        }
        if (path.endsWith("/database-workflows"))
          return Response.json(result());
        if (path.endsWith(`/database-workflows/${id}`)) {
          posts++;
          const body = (await request.json()) as { decision: string };
          if (body.decision !== "approve")
            throw new Error("Unexpected decision");
          phase = phase === "review" ? "backup" : "setup";
          // The first approval is saved but its HTTP acknowledgement is lost.
          if (posts === 1) return new Response("Unavailable", { status: 503 });
          return Response.json(result());
        }
        return new Response(
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main id="root" style="max-width:520px;margin:40px auto;padding:16px"></main><script src="/fixture.js"></script>',
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "fixture.tsx"),
        config = join(directory, "tsconfig.json");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            paths: {
              "@/*": [web + "/*"],
              react: [Bun.resolveSync("react", web)],
              "react-dom/client": [Bun.resolveSync("react-dom/client", web)],
              "react/jsx-runtime": [Bun.resolveSync("react/jsx-runtime", web)],
              "@tanstack/react-query": [
                Bun.resolveSync("@tanstack/react-query", web),
              ],
            },
          },
        }),
      );
      await writeFile(
        entry,
        `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{DatabaseWorkflowCard,useDatabaseWorkflowCards}from${JSON.stringify(join(web, "components/workspace/conversation/database-workflow.tsx"))};const query=new QueryClient();function Page(){const{data}=useDatabaseWorkflowCards(${JSON.stringify(project)});return <>{data?.workflows.map(card=><DatabaseWorkflowCard key={card.id} card={card} projectId=${JSON.stringify(project)} canManage={data.canManage} onView={()=>{}}/>)}</>}createRoot(document.getElementById('root')).render(<QueryClientProvider client={query}><Page/></QueryClientProvider>);(async()=>{const until=async(f)=>{for(let i=0;i<150;i++){if(f())return;await new Promise(r=>setTimeout(r,60));}throw Error('Expected state missing: '+document.body.textContent)};const button=text=>Array.from(document.querySelectorAll('button')).find(n=>n.textContent===text);try{if(!sessionStorage.getItem('approved')){await until(()=>button('Create database & build'));button('Create database & build').click();await until(()=>document.body.textContent.includes('Setting up your database'));sessionStorage.setItem('approved','yes');location.reload();return;}await until(()=>document.body.textContent.includes('Setting up your database'));if(button('Create database & build'))throw Error('Reload offered duplicate setup');await fetch('/review');query.invalidateQueries();await until(()=>button('Back up, rehearse & apply'));document.querySelector('summary').click();if(!document.body.textContent.includes('CREATE TABLE notes'))throw Error('Missing migration source');button('Back up, rehearse & apply').click();await until(()=>document.body.textContent.includes('Creating and verifying a backup'));await fetch('/complete');query.invalidateQueries();await until(()=>document.body.textContent.includes('Database connected'));await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await until(()=>innerWidth>=400&&document.getElementById('root').getBoundingClientRect().width>200);if(document.documentElement.scrollWidth>innerWidth)throw Error('Card overflows narrow viewport '+innerWidth+' / '+document.documentElement.scrollWidth+' / '+document.getElementById('root').getBoundingClientRect().width);await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})});}})();`,
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
          "--tsconfig-override",
          config,
          "--outdir",
          directory,
        ],
        { cwd: web, stdout: "ignore", stderr: "pipe" },
      );
      const diagnostic = new Response(built.stderr).text();
      if ((await built.exited) !== 0) throw new Error(await diagnostic);
      await diagnostic;
      bundle = await readFile(join(directory, "fixture.js"), "utf8");
      chrome = Bun.spawn(
        [
          process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
          "--headless=new",
          "--disable-gpu",
          "--disable-background-networking",
          "--no-first-run",
          "--virtual-time-budget=20000",
          `--user-data-dir=${join(directory, "chrome")}`,
          "--window-size=430,1000",
          `--screenshot=${join(directory, "card.png")}`,
          server.url.origin,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const browserDiagnostics =
        typeof chrome.stderr === "number"
          ? Promise.resolve("Browser stderr unavailable")
          : new Response(chrome.stderr).text();
      await chrome.exited;
      await browserDiagnostics;
      chrome = undefined;
      expect(report).toEqual({ ok: true });
      expect(posts).toBe(2);
    } finally {
      chrome?.kill();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
