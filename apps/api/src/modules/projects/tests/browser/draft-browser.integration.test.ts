// Actual React controls, controlled services and no inference.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const suite =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
suite("Chrome project drafts", () => {
  test("creation/save replay, conflict review, archive, read-only access and reviewed handoff without execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-draft-browser-")),
      web = resolve(import.meta.dir, "../../../../../../web");
    const captures = process.env.WRENLY_TEST_ENTRY_SCREENSHOTS ?? directory;
    if (!captures.startsWith("/tmp/"))
      throw new Error("Use temporary captures.");
    await mkdir(captures, { recursive: true });
    const css = (
      await Promise.all(
        (
          await Array.fromAsync(
            new Bun.Glob("*.css").scan({ cwd: join(web, ".next/static/css") }),
          )
        ).map((file) => readFile(join(web, ".next/static/css", file), "utf8")),
      )
    ).join("\n");
    if (!css) throw new Error("Build web with --webpack before styled checks.");
    const id = crypto.randomUUID(),
      reports = new Map<string, { ok?: boolean; error?: string }>();
    const fixture = () => ({
      id,
      title: "An idea for later",
      body: "The original saved idea.",
      revision: crypto.randomUUID(),
      accessMode: "private",
      instanceRole: "viewer",
      archivedAt: null as string | null,
      updatedAt: new Date().toISOString(),
      updatedByName: "James",
      capabilities: { role: "owner", contribute: true, manage: true },
      members: [],
    });
    let saved = fixture(),
      name = "",
      bundle = "",
      patches: Record<string, unknown>[] = [],
      creates: Record<string, unknown>[] = [],
      execution = 0;
    const acknowledgements = new Map<string, string>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript" },
          });
        if (url.pathname === "/styles.css")
          return new Response(css, { headers: { "content-type": "text/css" } });
        if (url.pathname === "/font.woff")
          return new Response(Bun.file(join(web, "app/fonts/GeistVF.woff")));
        if (url.pathname === "/report") {
          reports.set(
            name,
            (await request.json()) as { ok?: boolean; error?: string },
          );
          return new Response("ok");
        }
        if (url.pathname === "/fixture-created-id") return Response.json({ id: creates[0]?.draftId });
        if (url.pathname === "/external") {
          saved = {
            ...saved,
            body: "A newer saved version.",
            revision: crypto.randomUUID(),
          };
          return new Response("ok");
        }
        if (url.pathname === "/api/auth/get-session")
          return Response.json({
            user: {
              id: "fixture",
              name: "James",
              email: "fixture@example.test",
            },
            session: {
              id: "fixture",
              userId: "fixture",
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            },
          });
        if (url.pathname === "/api/instance/setup-summary")
          return Response.json({
            role: "user",
            accountConfigured: true,
            providerConfigured: false,
            defaultModel: {
              state: "missing",
              modelId: null,
              providerLabel: null,
              source: null,
            },
            preview: "operator-setup",
            publishing: "operator-setup",
            connectionHealth: "not-checked",
            hasProjects: false,
            features: {
              preview: { enabled: false },
              publishing: { enabled: false },
            },
          });
        if (url.pathname === "/api/models")
          return Response.json({ models: [], providers: [], envDefault: "", defaultProvider: null });
        if (url.pathname === "/api/projects") {
          if (request.method !== "GET") execution++;
          return Response.json({ projects: [] });
        }
        if (url.pathname === "/api/drafts" && request.method === "POST") {
          const input = (await request.json()) as Record<string, unknown>;
          creates.push(input);
          if (creates.length === 1)
            return Response.json(
              { error: "Acknowledgement lost" },
              { status: 503 },
            );
          return Response.json({
            draft: { ...saved, id: String(input.draftId) },
            savedRevision: saved.revision,
            replayed: true,
          });
        }
        if (url.pathname === "/api/drafts")
          return Response.json({ drafts: [], hasMore: false });
        if (url.pathname === `/api/drafts/${id}/members`)
          return Response.json({
            members: [{ userId: "friend", name: "A friend" }],
          });
        if (url.pathname === `/api/drafts/${id}`) {
          if (request.method === "PATCH") {
            const input = (await request.json()) as Record<string, unknown>;
            patches.push(input);
            const key = String(input.requestId),
              prior = acknowledgements.get(key);
            if (prior)
              return Response.json({
                draft: saved,
                savedRevision: prior,
                replayed: true,
              });
            if (input.expectedRevision !== saved.revision)
              return Response.json(
                { error: "Draft changed elsewhere. Review saved text." },
                { status: 409 },
              );
            saved = {
              ...saved,
              revision: crypto.randomUUID(),
              updatedAt: new Date().toISOString(),
              ...(input.kind === "content"
                ? { title: String(input.title), body: String(input.body) }
                : input.kind === "archive"
                  ? {
                      archivedAt: input.archived
                        ? new Date().toISOString()
                        : null,
                    }
                  : {}),
            };
            acknowledgements.set(key, saved.revision);
            if (patches.length === 1)
              return Response.json(
                { error: "Acknowledgement lost" },
                { status: 503 },
              );
            return Response.json({
              draft: saved,
              savedRevision: saved.revision,
              replayed: false,
            });
          }
          return Response.json({ draft: saved });
        }
        return new Response(
          `<!doctype html><html data-theme="${name.includes("dark") ? "dark" : "light"}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>@font-face{font-family:Geist;src:url('/font.woff');font-weight:100 900}:root{--font-geist-sans:Geist;--font-geist-mono:monospace}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const link = join(directory, "link.ts"),
      navigation = join(directory, "navigation.ts"),
      entry = join(directory, "entry.tsx"),
      output = join(directory, "bundle.js"),
      config = join(directory, "tsconfig.json");
    await writeFile(
      link,
      `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};export default function Link(props){return React.createElement('a',props)}`,
    );
    await writeFile(
      navigation,
      `export function useRouter(){return{push:value=>{window.fixtureRoute=value}}}`,
    );
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          baseUrl: web,
          paths: {
            "@/*": [web + "/*"],
            "next/link": [link],
            "next/navigation": [navigation],
            "@tanstack/react-query": [
              Bun.resolveSync("@tanstack/react-query", web),
            ],
          },
        },
      }),
    );
    await writeFile(
      entry,
      `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};import{createRoot}from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};import{QueryClient,QueryClientProvider}from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};import{DraftEditor}from ${JSON.stringify(join(web, "components/drafts/draft-editor.tsx"))};import{DraftCollection}from ${JSON.stringify(join(web, "components/drafts/draft-collection.tsx"))};import{Dashboard}from ${JSON.stringify(join(web, "components/dashboard/dashboard.tsx"))};
const scenario=new URLSearchParams(location.search).get('case');const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const Page=scenario==='create'?DraftCollection:scenario==='handoff'?Dashboard:DraftEditor;createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(Page,{id:${JSON.stringify(id)}})));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const until=async(check,label)=>{for(let i=0;i<800;i++){if(check())return;await sleep(10)}throw Error('Draft timeout: '+label)};const button=text=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()===text);const fill=(selector,text)=>{const node=document.querySelector(selector);Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,text);node.dispatchEvent(new Event('input',{bubbles:true}))};
(async()=>{try{
if(scenario==='create'){await until(()=>document.querySelector('#draft-title'),'new draft');fill('#draft-title','An idea for later');await until(()=>!button('New draft').disabled,'create enabled');button('New draft').click();await until(()=>button('Retry same creation'),'uncertain creation');if(!document.querySelector('#draft-title').disabled)throw Error('Creation identity not frozen');button('Retry same creation').click();await until(()=>window.fixtureRoute,'explicit same retry');const expected=await(await fetch('/fixture-created-id')).json();if(window.fixtureRoute!=='/projects/drafts/'+expected.id)throw Error('Unexpected draft route');}
else if(scenario==='handoff'){await until(()=>document.querySelector('.draft-handoff'),'handoff review');const area=document.querySelector('textarea');if(area.value)throw Error('Draft inserted without review');button('Use this saved draft').click();await until(()=>area.value==='The original saved idea.','explicit draft load');if(window.fixtureRoute)throw Error('Handoff created a project');}
else{await until(()=>document.querySelector('.draft-editor'),'editor');if(scenario==='viewer'){await until(()=>document.querySelector('.draft-readonly'),'read only');if(button('Save draft')||document.querySelector('#idea-text')||document.body.textContent.includes('Choose which accepted'))throw Error('Viewer got editor controls');}
else{await until(()=>document.querySelector('#idea-text'),'text');fill('#idea-text','Our refined idea.');await until(()=>!button('Save draft').disabled,'dirty');button('Save draft').click();await until(()=>button('Retry same save'),'lost acknowledgement');if(!document.querySelector('#idea-text').disabled)throw Error('Uncertain text not frozen');button('Retry same save').click();await until(()=>document.body.textContent.includes('Draft saved.'),'retry ack');await fetch('/external');fill('#idea-text','My unsent refinement.');await until(()=>!button('Save draft').disabled,'second draft');button('Save draft').click();await until(()=>document.querySelector('.draft-conflict'),'conflict');if(document.querySelector('#idea-text').value!=='My unsent refinement.')throw Error('Conflict lost unsent text');if(button('Review saved text'))button('Review saved text').click();await until(()=>button('Keep my draft'),'review');button('Keep my draft').click();await until(()=>!button('Save draft').disabled,'reviewed');button('Save draft').click();await until(()=>button('Archive draft')&&!button('Archive draft').disabled,'saved before archive');button('Archive draft').click();await until(()=>button('Restore draft'),'archive');if(document.querySelector('#idea-text'))throw Error('Archived draft editable');button('Restore draft').click();await until(()=>document.querySelector('#idea-text'),'restore');if(document.querySelector('#idea-text').value!=='My unsent refinement.')throw Error('Restore lost saved text');}}
await document.fonts.ready;if(document.documentElement.scrollWidth>innerWidth)throw Error('Draft overflow');await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})})}})();`,
    );
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const build = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          entry,
          "--target=browser",
          "--outfile=" + output,
          "--tsconfig-override=" + config,
          "--define",
          "process.env.NEXT_PUBLIC_WEB_URL=" +
            JSON.stringify(server.url.origin),
        ],
        { cwd: web, stdout: "ignore", stderr: "pipe" },
      );
      const diagnostic = await new Response(build.stderr).text();
      if ((await build.exited) !== 0) throw new Error(diagnostic);
      bundle = await readFile(output, "utf8");
      for (const scenario of [
        { id: "create", width: 390 },
        { id: "editor", width: 1440 },
        { id: "editor-phone", width: 320 },
        { id: "editor-dark", width: 1440 },
        { id: "viewer", width: 390 },
        { id: "handoff", width: 390 },
      ]) {
        name = scenario.id;
        saved = fixture();
        patches = [];
        creates = [];
        acknowledgements.clear();
        if (name === "viewer")
          saved = {
            ...saved,
            capabilities: { role: "viewer", contribute: false, manage: false },
          };
        const address = `${server.url.origin}/?case=${name}${name === "handoff" ? "&draft=" + id + "&revision=" + saved.revision : ""}`;
        chrome = Bun.spawn(
          [
            process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--no-first-run",
            "--hide-scrollbars",
            `--user-data-dir=${join(directory, name)}`,
            `--window-size=${scenario.width},1000`,
            "--virtual-time-budget=12000",
            `--screenshot=${join(captures, name + ".png")}`,
            address,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        const deadline = Date.now() + 20000;
        while (!reports.has(name) && Date.now() < deadline) await Bun.sleep(20);
        expect(reports.get(name)?.error).toBeUndefined();
        expect(reports.get(name)?.ok).toBe(true);
        if (name === "create") {
          expect(creates).toHaveLength(2);
          expect(creates[0]).toEqual(creates[1]);
        }
        if (name.startsWith("editor")) expect(patches[0]).toEqual(patches[1]);
        await chrome.exited;
        chrome = undefined;
      }
      expect(execution).toBe(0);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});
