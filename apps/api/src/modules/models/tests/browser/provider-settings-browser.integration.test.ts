// Real React forms in Chrome, fixture-only services and tokens.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome guided provider settings", () => {
  test("owner reviews compatibility, retries one creation, checks models, saves a default, rotates/disables and imports existing configuration; members cannot see credential forms", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-provider-browser-"));
    const web = resolve(import.meta.dir, "../../../../../../web");
    const id = crypto.randomUUID(),
      version = crypto.randomUUID();
    const connection = {
      id,
      version,
      label: "Fixture provider",
      protocol: "openai-compatible",
      kind: "cloud",
      endpoint: "https://fixture.example/v1",
      enabled: true,
      catalogProviderId: "fixture",
      tokenConfigured: true,
    };
    const providers = [
      {
        id: "unsupported",
        name: "Native protocol fixture",
        endpoint: "https://native.example",
        documentationUrl: null,
        compatibility: "adapter-required",
        modelCount: 1,
      },
      {
        id: "fixture",
        name: "Fixture provider",
        endpoint: connection.endpoint,
        documentationUrl: null,
        compatibility: "openai-compatible",
        modelCount: 1,
      },
    ];
    let bundle = "",
      created = false,
      checks = 0,
      member = false;
    let imported = false;
    const importId = crypto.randomUUID();
    const imports: Array<Record<string, unknown>> = [];
    const environment = {
      id: "ollama",
      label: "Existing Ollama",
      endpoint: "http://localhost:11434",
      kind: "local",
      protocol: "ollama",
      reviewVersion: "b".repeat(64),
    };
    let defaults: { connectionId: string; modelId: string } | null = null;
    let result: { ok?: boolean; error?: string } | undefined;
    const creations: Array<{
      requestId: string;
      token: string;
      providerId: string;
    }> = [];
    const updates: Array<{ id: string; token?: string; enabled?: boolean }> =
      [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "Content-Type": "text/javascript; charset=utf-8" },
          });
        if (url.pathname === "/report") {
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        if (url.pathname === "/member") {
          member = true;
          return new Response("ok");
        }
        if (url.pathname === "/api/models/catalog")
          return Response.json({
            version: "a".repeat(64),
            fetchedAt: new Date().toISOString(),
            stale: false,
            origin: "bundled",
            totalProviders: 2,
            totalModels: 1,
            providers,
            models: [{ id: "fixture-model", name: "Fixture model" }],
          });
        if (url.pathname === "/api/models/connections") {
          if (member)
            return Response.json(
              { error: "Only the instance owner can manage providers." },
              { status: 403 },
            );
          if (request.method === "POST") {
            const body = (await request.json()) as Record<string, unknown>;
            if (body.source === "environment") {
              imports.push(body);
              imported = true;
              return Response.json({ id: importId, version });
            }
            creations.push(body as (typeof creations)[number]);
            created = true;
            return creations.length === 1
              ? Response.json(
                  { error: "Acknowledgement lost" },
                  { status: 503 },
                )
              : Response.json({ id, version });
          }
          if (request.method === "PATCH") {
            const update = (await request.json()) as (typeof updates)[number];
            updates.push(update);
            if (update.enabled !== undefined)
              connection.enabled = update.enabled;
            return Response.json({ saved: true });
          }
          return Response.json({
            connections: [
              ...(created ? [connection] : []),
              ...(imported
                ? [
                    {
                      ...connection,
                      id: importId,
                      label: "Imported Ollama",
                      envSourceId: "ollama",
                      enabled: true,
                      catalogProviderId: null,
                      kind: "local",
                      protocol: "ollama",
                      endpoint: environment.endpoint,
                      tokenConfigured: false,
                    },
                  ]
                : []),
            ],
            environment: [environment],
            default: defaults,
          });
        }
        if (url.pathname === "/api/models/connections/probe") {
          checks++;
          return Response.json({
            state: checks === 1 ? "empty" : "ready",
            models: checks === 1 ? [] : ["fixture-model"],
          });
        }
        if (url.pathname === "/api/models/default") {
          defaults = (await request.json()) as typeof defaults;
          return Response.json({ saved: true });
        }
        return new Response(
          `<div id="root"></div><script>window.addEventListener('error',event=>fetch('/report',{method:'POST',body:JSON.stringify({error:event.error?.stack??event.message})}));window.addEventListener('unhandledrejection',event=>fetch('/report',{method:'POST',body:JSON.stringify({error:String(event.reason)})}));</script><script type="module" src="/bundle.js"></script>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "fixture.ts");
      await writeFile(
        entry,
        `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};
        import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};
        import {QueryClient,QueryClientProvider} from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};
        import Page from ${JSON.stringify(join(web, "app/(app)/settings/providers/page.tsx"))};
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(Page)));
        const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const until=async check=>{for(let n=0;n<600;n++){if(check())return;await sleep(10)}throw Error('Provider browser timed out: '+document.body.textContent)};
        const button=text=>Array.from(document.querySelectorAll('button')).find(node=>(node.getAttribute('aria-label')||node.textContent)===text);
        const input=label=>Array.from(document.querySelectorAll('label')).find(node=>node.textContent.startsWith(label))?.querySelector('input');
        const fill=(node,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))};
        (async()=>{try{
          if(location.search.includes('member')){
            await until(()=>document.querySelector('[role=alert]'));if(document.querySelector('input[type=password]')||document.querySelector('form'))throw Error('Member saw credential controls');
            await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});return;
          }
          await until(()=>button('Hosted provider'));button('Hosted provider').click();await until(()=>document.body.textContent.includes('Native protocol fixture'));
          Array.from(document.querySelectorAll('button')).find(node=>node.textContent.includes('Native protocol fixture')).click();
          await until(()=>document.body.textContent.includes('has not enabled yet'));if(document.querySelector('input[type=password]'))throw Error('Unsupported provider requested token');
          Array.from(document.querySelectorAll('button')).find(node=>node.textContent.startsWith('Fixture provider')).click();await until(()=>input('API token'));
          if(!document.body.textContent.includes('https://fixture.example/v1'))throw Error('Destination not reviewed');
          fill(input('API token'),'fixture-secret');await sleep(30);button('Save connection').click();await until(()=>document.body.textContent.includes('Acknowledgement lost'));
          await until(()=>!button('Save connection').disabled);button('Save connection').click();await until(()=>button('Check connection'));
          if(input('API token').value)throw Error('Created token remained in input');
          button('Check connection').click();await until(()=>document.body.textContent.includes('did not list models'));
          button('Check connection').click();await until(()=>document.body.textContent.includes('1 served models found'));
          document.querySelector('[aria-label="Choose a served model"]').click();await until(()=>document.querySelector('[role=option]'));Array.from(document.querySelectorAll('[role=option]')).find(node=>node.textContent==='fixture-model').click();
          await until(()=>input('Model ID for').value==='fixture-model');button('Set instance default').click();await until(()=>document.body.textContent.includes('Instance default saved'));
          document.querySelector('details').open=true;fill(input('New token'),'rotated-secret');await sleep(30);button('Replace token').click();await until(()=>document.body.textContent.includes('Token replaced'));
          if(input('New token').value)throw Error('Replacement token remained in input');
          button('Disable').click();await until(()=>button('Enable'));if(!button('Check connection').disabled)throw Error('Disabled connection allowed check');
          button('Refresh saved connections').click();await until(()=>button('Enable')&&!button('Refresh saved connections').disabled);
          if(!document.body.textContent.includes('Default model: fixture-model'))throw Error('Default did not survive reload');
          Array.from(document.querySelectorAll('.provider-steps button')).find(node=>node.textContent.includes('Connect a provider')).click();document.querySelector('.provider-import').open=true;button('Import connection').click();await until(()=>button('Imported'));if(!button('Imported').disabled)throw Error('Imported source allowed duplicate import');
          if(localStorage.length||sessionStorage.length)throw Error('Provider credentials persisted in browser storage');
          await fetch('/member');location.href='/settings/providers?member';
        }catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})})}})();`,
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
          `${server.url.origin}/settings/providers`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 20_000;
      while (!result && Date.now() < deadline) await Bun.sleep(20);
      expect(result?.error).toBeUndefined();
      expect(result?.ok).toBe(true);
      expect(creations).toHaveLength(2);
      expect(creations[0]?.requestId).toBe(creations[1]?.requestId);
      expect(creations[1]?.providerId).toBe("fixture");
      expect(
        defaults as { connectionId: string; modelId: string } | null,
      ).toEqual({ connectionId: id, modelId: "fixture-model" });
      expect(imports).toHaveLength(1);
      expect(imports[0]).toMatchObject({
        source: "environment",
        envSourceId: "ollama",
        reviewVersion: environment.reviewVersion,
      });
      expect(imports[0]).not.toHaveProperty("token");
      expect(imports[0]).not.toHaveProperty("endpoint");
      expect(updates).toEqual([
        { id, token: "rotated-secret" },
        { id, enabled: false },
      ]);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
