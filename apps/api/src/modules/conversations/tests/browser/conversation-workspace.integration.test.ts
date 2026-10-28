// Real Chrome + workspace, with deterministic API responses and no inference/DB/generated execution.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
const integration =
  process.env.WRENLY_TEST_PREVIEW_BROWSER === "true" ? describe : describe.skip;
integration("Chrome conversation workspace", () => {
  test("recovers one ambiguous request, binds old revisions, follows builds through reload and renders safe messages", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-conversation-workspace-"),
    );
    const project = crypto.randomUUID();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const d = crypto.randomUUID();
    const conversation = crypto.randomUUID();
    const stamp = new Date().toISOString();
    const builds = [b, a].map((id, index) => ({
      id,
      prompt: index ? "Older revision" : "Newest revision",
      model: "fixture",
      provider: "fixture",
      stack: "nextjs",
      parentBuildId: null as string | null,
      status: "success",
      outcome: "success",
      attemptCount: 1,
      buildLog: "Validated fixture",
      errorMessage: null,
      deployedUrl: null,
      files: [
        {
          path: "package.json",
          content: JSON.stringify({
            label: index ? "Old source" : "Newest source",
          }),
        },
      ],
      createdAt: stamp,
    }));
    const messages: Array<Record<string, unknown>> = [];
    const turns: Array<Record<string, unknown>> = [];
    const submissions: Array<{
      mode: string;
      baseBuildId: string | null;
      key: string;
    }> = [];
    const keys = new Map<string, string>();
    let posts = 0;
    let directBuilds = 0;
    let imageRequests = 0;
    let finished = false;
    let bundle = "";
    let result: { ok?: boolean; error?: string } | undefined;
    let release: (() => void) | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 60,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        if (url.pathname === "/report") {
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        if (url.pathname === "/image-tracker") {
          imageRequests++;
          return new Response("");
        }
        if (url.pathname === "/finish") {
          finished = true;
          const build = builds.find((row) => row.id === d);
          if (build) {
            build.status = "success";
            build.outcome = "success";
          }
          const turn = turns.find((row) => row.buildId === d);
          if (turn) turn.status = "completed";
          release?.();
          return new Response("ok");
        }
        if (url.pathname === "/api/models")
          return Response.json({
            envDefault: "fixture",
            defaultProvider: "fixture",
            models: [
              {
                id: "fixture",
                label: "Fixture",
                provider: "fixture",
                kind: "local",
              },
            ],
            providers: [
              {
                id: "fixture",
                label: "Fixture",
                kind: "local",
                displayUrl: "localhost:11434",
                hint: null,
                reachable: true,
              },
            ],
          });
        if (url.pathname === `/api/projects/${project}`)
          return Response.json({
            project: {
              id: project,
              name: "Conversation fixture",
              stack: "nextjs",
            },
            builds,
          });
        if (url.pathname === `/api/projects/${project}/messages`) {
          if (request.method === "POST") {
            posts++;
            const key = request.headers.get("Idempotency-Key")!;
            if (keys.has(key))
              return Response.json({
                turnId: keys.get(key),
                conversationId: conversation,
                replayed: true,
              });
            const body = (await request.json()) as {
              message: string;
              mode: string;
              baseBuildId: string | null;
            };
            const id = crypto.randomUUID();
            keys.set(key, id);
            submissions.push({
              mode: body.mode,
              baseBuildId: body.baseBuildId,
              key,
            });
            const turn = {
              id,
              mode: body.mode,
              status: body.mode === "auto" ? "running" : "completed",
              baseBuildId: body.baseBuildId,
              buildId: null as string | null,
              errorMessage: null,
              model: "fixture",
              provider: "fixture",
            };
            turns.push(turn);
            messages.push({
              id: crypto.randomUUID(),
              turnId: id,
              sequence: messages.length + 1,
              role: "user",
              content: body.message,
              kind: "message",
              createdAt: stamp,
            });
            if (body.mode === "auto") {
              setTimeout(() => {
                turn.status = "waiting_build";
                turn.buildId = d;
                messages.push({
                  id: crypto.randomUUID(),
                  turnId: id,
                  sequence: messages.length + 1,
                  role: "assistant",
                  content: "I will change the heading and preserve the rest.",
                  kind: "propose_build",
                  createdAt: stamp,
                });
                builds.unshift({
                  ...builds[0]!,
                  id: d,
                  parentBuildId: a,
                  prompt: "Change the heading",
                  status: "generating",
                  outcome: "running",
                  files: [
                    {
                      path: "package.json",
                      content: '{"label":"Edited source","preserved":true}',
                    },
                  ],
                });
              }, 400);
            } else
              messages.push({
                id: crypto.randomUUID(),
                turnId: id,
                sequence: messages.length + 1,
                role: "assistant",
                content:
                  "# Saved answer\n\nThe selected revision is available.\n\n<script>window.modelScriptRan=true</script>\n![tracker](/image-tracker)\n[unsafe](javascript:alert(1))",
                kind: "answer",
                createdAt: stamp,
              });
            if (submissions.length === 1)
              return Response.json(
                { error: "Acknowledgement lost after commit" },
                { status: 503 },
              );
            return Response.json(
              { turnId: id, conversationId: conversation, replayed: false },
              { status: 202 },
            );
          }
          const after = Number(url.searchParams.get("after") ?? 0);
          const page = messages
            .filter((message) => Number(message.sequence) > after)
            .slice(0, 100);
          return Response.json({
            conversationId: conversation,
            messages: page,
            turns: turns.filter((turn) =>
              page.some((message) => message.turnId === turn.id),
            ),
            latestTurn: turns.at(-1) ?? null,
            nextCursor: null,
          });
        }
        if (url.pathname === "/api/builds" && request.method === "POST") {
          directBuilds++;
          return Response.json(
            { error: "Unexpected direct generation" },
            { status: 500 },
          );
        }
        if (url.pathname === `/api/builds/${d}`)
          return Response.json({
            build: builds.find((row) => row.id === d),
            outcome: finished ? "success" : "running",
            cursor: finished ? 2 : 1,
          });
        if (url.pathname === `/api/builds/${d}/events`)
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                try {
                  if (!finished)
                    await new Promise<void>((resolve) => {
                      release = resolve;
                      request.signal.addEventListener(
                        "abort",
                        () => resolve(),
                        { once: true },
                      );
                    });
                  if (request.signal.aborted) {
                    controller.close();
                    return;
                  }
                  controller.enqueue(
                    new TextEncoder().encode(
                      `id: 2\nevent: complete\ndata: ${JSON.stringify({ buildId: d, success: true, outcome: "success", attempt: 1, buildLog: "Validated fixture" })}\n\n`,
                    ),
                  );
                  controller.close();
                } catch {
                  /* Viewer reload cancels this fixture subscription only. */
                }
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        if (/\/api\/builds\/[^/]+\/preview$/.test(url.pathname))
          return Response.json({
            enabled: false,
            supported: true,
            preview: null,
            activePreview: null,
          });
        return new Response(
          '<meta charset="utf-8"><div id="root"></div><script>window.onerror=(message,source,line,column,error)=>fetch("/report",{method:"POST",body:JSON.stringify({error:error?.stack||String(message)})});window.onunhandledrejection=(event)=>fetch("/report",{method:"POST",body:JSON.stringify({error:String(event.reason)})})</script><script type="module" src="/bundle.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const web = resolve(import.meta.dir, "../../../../../../web");
    const fixture = `import React from ${JSON.stringify(resolve(web, "node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(resolve(web, "node_modules/react-dom/client.js"))};import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {WorkspaceWrapper} from ${JSON.stringify(resolve(web, "components/workspace/workspace.tsx"))};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const until=async check=>{for(let i=0;i<900;i++){if(check())return;await sleep(20)}throw Error('workspace condition timed out: '+document.body.textContent.slice(-700))};const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);const type=text=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}))};const modeControl=async()=>{const options=document.querySelector('[aria-label="Prompt options"]');if(options.getAttribute('aria-expanded')!=='true'){options.click();await until(()=>options.getAttribute('aria-expanded')==='true')}return document.querySelector('[aria-label="Plan mode"]')};const mode=async value=>{const control=await modeControl();if(control.getAttribute('aria-checked')!==String(value==='plan'))control.click();await until(()=>control.getAttribute('aria-checked')===String(value==='plan'));const options=document.querySelector('[aria-label="Prompt options"]');if(options?.getAttribute('aria-expanded')==='true')options.click()};const code=()=>[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Code')).click();
function App(){React.useEffect(()=>{(async()=>{try{const phase=localStorage.getItem('fixture-phase');await until(()=>document.querySelector('textarea')&&(phase==='building'||!document.querySelector('textarea').disabled));if(!phase){if((await modeControl()).getAttribute('aria-checked')!=='false')throw Error('Auto is not default');await mode('plan');type('Why did it fail?');await sleep(20);document.querySelector('[aria-label="Send prompt"]').click();await until(()=>document.body.textContent.includes('acceptance is unconfirmed'));localStorage.setItem('fixture-phase','restore');location.reload();return}if(phase==='restore'){await until(()=>document.querySelector('h1')?.textContent==='Saved answer');if(window.modelScriptRan||document.querySelector('img'))throw Error('Unsafe model rendering');if([...document.querySelectorAll('a')].some(a=>a.getAttribute('href')?.startsWith('javascript:')))throw Error('Unsafe model URL');if(!document.body.textContent.includes('Selected revision ${a.slice(0, 8)}'))throw Error('Old revision not restored');await mode('auto');type('Change the heading');await sleep(20);document.querySelector('[aria-label="Send prompt"]').click();document.querySelector('[aria-label="Revision history"]').click();await until(()=>[...document.querySelectorAll('[role="menuitem"]')].some(e=>e.textContent.includes('Newest revision')));[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('Newest revision')).click();await until(()=>button('View build progress'));await sleep(250);if(!document.body.textContent.includes('Selected revision ${b.slice(0, 8)}'))throw Error('Late action replaced browsed revision');code();await until(()=>document.body.textContent.includes('Newest source'));button('View build progress').click();await until(()=>document.body.textContent.includes('Edited source'));localStorage.setItem('fixture-phase','building');location.reload();return}await until(()=>document.body.textContent.includes('Selected revision ${d.slice(0, 8)}'));await fetch('/finish');await until(()=>document.querySelector('[data-turn-id]')&&[...document.querySelectorAll('[data-build-activity]')].some(e=>e.textContent.includes('Build succeeded')));await until(()=>!document.querySelector('textarea').disabled);code();await until(()=>document.body.textContent.includes('Edited source'));await mode('plan');type('Why did it fail?');await sleep(20);document.querySelector('[aria-label="Send prompt"]').click();await until(()=>document.querySelectorAll('[data-turn-id]').length===3);await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})})}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.stack??error.message})})}})()},[]);return React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(WorkspaceWrapper,{projectId:${JSON.stringify(project)}}))}createRoot(document.getElementById('root')).render(React.createElement(App));`;
    const entry = join(directory, "fixture.tsx");
    await writeFile(entry, fixture);
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      bundle = await bundleWorkspace(entry, web, server.url.origin);
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
          `http://localhost:${server.port}/p/${project}?build=${a}`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 45000;
      while (!result && Date.now() < deadline) await Bun.sleep(20);
      expect(result?.error).toBeUndefined();
      expect(result?.ok).toBe(true);
      expect(submissions).toHaveLength(3);
      expect(posts).toBe(4);
      expect(directBuilds).toBe(0);
      expect(imageRequests).toBe(0);
      expect(submissions.map((row) => row.mode)).toEqual([
        "plan",
        "auto",
        "plan",
      ]);
      expect(submissions.map((row) => row.baseBuildId)).toEqual([a, a, d]);
      expect(keys.size).toBe(3);
    } finally {
      chrome?.kill();
      if (chrome) await chrome.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
  test("switching projects fences late admission and preserves separate pending keys", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-conversation-projects-"),
    );
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const turnA = crypto.randomUUID();
    const turnB = crypto.randomUUID();
    let bundle = "";
    let result:
      | { ok?: boolean; error?: string; pendingA?: boolean; pendingB?: boolean }
      | undefined;
    const posts: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        if (url.pathname === "/report") {
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        if (url.pathname.startsWith("/api/projects/")) {
          const project = url.pathname.split("/")[3]!;
          if (request.method === "POST") {
            posts.push(project);
            if (project === a) await Bun.sleep(1000);
            return Response.json(
              { turnId: project === a ? turnA : turnB },
              { status: 202 },
            );
          }
          const turn = {
            id: project === a ? turnA : turnB,
            mode: "ask",
            status: "completed",
            baseBuildId: null,
            buildId: null,
            errorMessage: null,
            model: "fixture",
            provider: "fixture",
          };
          return Response.json({
            conversationId: project,
            latestTurn: turn,
            turns: [turn],
            nextCursor: null,
            messages:
              Number(url.searchParams.get("after") ?? 0) === 0
                ? [
                    {
                      id: project,
                      turnId: turn.id,
                      sequence: 1,
                      role: "user",
                      content:
                        project === a
                          ? "A private message"
                          : "B current message",
                      kind: "message",
                      createdAt: new Date().toISOString(),
                    },
                  ]
                : [],
          });
        }
        return new Response(
          '<meta charset="utf-8"><div id="root"></div><script>window.onerror=(message)=>fetch("/report",{method:"POST",body:JSON.stringify({error:String(message)})})</script><script type="module" src="/bundle.js"></script>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
    const web = resolve(import.meta.dir, "../../../../../../web");
    const entry = join(directory, "fixture.tsx");
    await writeFile(
      entry,
      `import React from ${JSON.stringify(resolve(web, "node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(resolve(web, "node_modules/react-dom/client.js"))};import {useConversation} from ${JSON.stringify(resolve(web, "hooks/use-conversation.ts"))};function App(){const[project,setProject]=React.useState(${JSON.stringify(a)});const conversation=useConversation(project);const started=React.useRef(new Set());React.useEffect(()=>{if(conversation.loading||started.current.has(project))return;started.current.add(project);if(project===${JSON.stringify(a)}){void conversation.submit({message:'A pending request',mode:'ask',baseBuildId:null});setTimeout(()=>setProject(${JSON.stringify(b)}),50)}else{(async()=>{try{const accepted=await conversation.submit({message:'B request',mode:'ask',baseBuildId:null});if(!accepted)throw Error('A admission blocked project B');await new Promise(r=>setTimeout(r,1400));if(document.body.textContent.includes('A private message')||!document.body.textContent.includes('B current message'))throw Error('Late A replaced B');await fetch('/report',{method:'POST',body:JSON.stringify({ok:true,pendingA:!!sessionStorage.getItem('wrenly:conversation-pending:${a}'),pendingB:!!sessionStorage.getItem('wrenly:conversation-pending:${b}')})})}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.stack??error.message})})}})()}},[project,conversation.loading]);return React.createElement('div',null,conversation.messages.map(message=>React.createElement('p',{key:message.id},message.content)))}createRoot(document.getElementById('root')).render(React.createElement(App));`,
    );
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      bundle = await bundleWorkspace(entry, web, server.url.origin);
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
          `http://localhost:${server.port}/`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 10000;
      while (!result && Date.now() < deadline) await Bun.sleep(20);
      expect(result?.error).toBeUndefined();
      expect(result?.ok).toBe(true);
      expect(result?.pendingA).toBe(true);
      expect(result?.pendingB).toBe(false);
      expect(posts).toEqual([a, b]);
    } finally {
      chrome?.kill();
      if (chrome) await chrome.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);

  test("response retry creates a new message with the failed turn settings and base revision", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-conversation-retry-"),
    );
    const project = crypto.randomUUID();
    const build = crypto.randomUUID();
    const original = crypto.randomUUID();
    const retried = crypto.randomUUID();
    const stamp = new Date().toISOString();
    const originalTurn = {
      id: original,
      status: "failed",
      mode: "ask",
      baseBuildId: build,
      buildId: null,
      errorMessage: "Provider unavailable",
      model: "saved-model",
      provider: "saved-provider",
    };
    const turns = [originalTurn];
    const messages = [
      {
        id: crypto.randomUUID(),
        turnId: original,
        sequence: 1,
        role: "user",
        content: "Explain this revision",
        kind: "message",
        createdAt: stamp,
      },
    ];
    let captured: Record<string, unknown> | undefined;
    let posts = 0;
    let directBuilds = 0;
    let bundle = "";
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
        if (url.pathname === "/report") {
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        if (url.pathname === "/api/models")
          return Response.json({
            envDefault: "current-model",
            defaultProvider: "current-provider",
            models: [
              {
                id: "current-model",
                label: "Current model",
                provider: "current-provider",
                kind: "local",
              },
            ],
            providers: [],
          });
        if (url.pathname === `/api/projects/${project}`)
          return Response.json({
            project: { id: project, name: "Retry fixture", stack: "nextjs" },
            builds: [
              {
                id: build,
                prompt: "Base",
                status: "success",
                attemptCount: 1,
                files: [{ path: "package.json", content: "{}" }],
                buildLog: "",
                errorMessage: null,
                deployedUrl: null,
                createdAt: stamp,
              },
            ],
          });
        if (url.pathname === `/api/projects/${project}/messages`) {
          if (request.method === "POST") {
            posts++;
            captured = (await request.json()) as Record<string, unknown>;
            turns.push({
              ...originalTurn,
              id: retried,
              status: "completed",
              errorMessage: "",
            });
            messages.push(
              {
                ...messages[0]!,
                id: crypto.randomUUID(),
                turnId: retried,
                sequence: 2,
              },
              {
                ...messages[0]!,
                id: crypto.randomUUID(),
                turnId: retried,
                sequence: 3,
                role: "assistant",
                kind: "answer",
                content: "Recovered response",
              },
            );
            return Response.json({ turnId: retried }, { status: 202 });
          }
          return Response.json({
            conversationId: project,
            messages: messages.filter(
              (message) =>
                message.sequence > Number(url.searchParams.get("after") ?? 0),
            ),
            turns,
            latestTurn: turns.at(-1),
            nextCursor: null,
          });
        }
        if (url.pathname === "/api/builds" && request.method === "POST")
          directBuilds++;
        if (/\/api\/builds\/[^/]+\/preview$/.test(url.pathname))
          return Response.json({
            enabled: false,
            supported: true,
            preview: null,
            activePreview: null,
          });
        return new Response(
          '<meta charset="utf-8"><div id="root"></div><script>window.onerror=(message)=>fetch("/report",{method:"POST",body:JSON.stringify({error:String(message)})})</script><script type="module" src="/bundle.js"></script>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
    const web = resolve(import.meta.dir, "../../../../../../web");
    const entry = join(directory, "fixture.tsx");
    await writeFile(
      entry,
      `import React from ${JSON.stringify(resolve(web, "node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(resolve(web, "node_modules/react-dom/client.js"))};import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {WorkspaceWrapper} from ${JSON.stringify(resolve(web, "components/workspace/workspace.tsx"))};function App(){React.useEffect(()=>{(async()=>{const until=async check=>{for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,20))}throw Error('Retry workspace timed out')};try{await until(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Retry response'&&!b.disabled));[...document.querySelectorAll('button')].find(b=>b.textContent==='Retry response').click();await until(()=>document.body.textContent.includes('Recovered response'));if(!document.body.textContent.includes('Provider unavailable'))throw Error('Original failure disappeared');await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})})}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.stack??error.message})})}})()},[]);return React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(WorkspaceWrapper,{projectId:${JSON.stringify(project)}}))}createRoot(document.getElementById('root')).render(React.createElement(App));`,
    );
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      bundle = await bundleWorkspace(entry, web, server.url.origin);
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
          `http://localhost:${server.port}/p/${project}?build=${build}`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 12000;
      while (!result && Date.now() < deadline) await Bun.sleep(20);
      expect(result?.error).toBeUndefined();
      expect(result?.ok).toBe(true);
      expect(posts).toBe(1);
      expect(directBuilds).toBe(0);
      expect(captured).toEqual({
        message: "Explain this revision",
        mode: "ask",
        baseBuildId: build,
        model: "saved-model",
        provider: "saved-provider",
      });
    } finally {
      chrome?.kill();
      if (chrome) await chrome.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
});

async function bundleWorkspace(
  entry: string,
  web: string,
  webUrl: string,
): Promise<string> {
  const queryEntry = Bun.resolveSync("@tanstack/react-query", web);
  const output = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: false,
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_WEB_URL": JSON.stringify(webUrl),
      "process.env": "{}",
    },
    plugins: [
      {
        name: "workspace-resolution",
        setup(build) {
          build.onResolve({ filter: /^@tanstack\/react-query$/ }, () => ({
            path: queryEntry,
          }));
          build.onResolve({ filter: /^@\// }, (args) => ({
            path: Bun.resolveSync(resolve(web, args.path.slice(2)), web),
          }));
          // Bun.resolveSync uses Node conditions; preserve vfile's published browser replacements in this fixture.
          build.onResolve({ filter: /^#min(path|proc|url)$/ }, (args) =>
            args.importer.includes("/vfile/")
              ? {
                  path: resolve(
                    dirname(args.importer),
                    args.path.slice(1) + ".browser.js",
                  ),
                }
              : undefined,
          );
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (args.path.startsWith("node:")) return undefined;
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
    throw new Error(output.logs.map((log) => log.message).join("; "));
  return output.outputs[0].text();
}
