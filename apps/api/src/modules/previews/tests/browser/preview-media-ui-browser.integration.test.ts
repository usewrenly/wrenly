// Exercises actual media controls in Chrome with controlled project metadata and save outcomes.
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const integration =
  process.env.WRENLY_TEST_PREVIEW_BROWSER === "true" ? describe : describe.skip;
integration("preview media owner control", () => {
  test("lost acknowledgement retries the frozen request and read-only members cannot change hosts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-media-ui-")),
      web = resolve(import.meta.dir, "../../../../../../web");
    let bundle = "",
      result: unknown,
      viewer = false,
      revision = crypto.randomUUID(),
      origins: string[] = [];
    const requests: string[] = [];
    const project = crypto.randomUUID();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript" },
          });
        if (url.pathname === "/report") {
          result = await request.json();
          return new Response("ok");
        }
        if (url.pathname === "/viewer") {
          viewer = true;
          return new Response("ok");
        }
        if (url.pathname.endsWith("/preview-media")) {
          if (request.method === "PATCH") {
            requests.push(await request.text());
            const input = JSON.parse(requests.at(-1)!);
            if (viewer)
              return Response.json({ error: "Forbidden" }, { status: 403 });
            if (requests.length === 1) {
              revision = crypto.randomUUID();
              origins = input.origins;
              return Response.json(
                { error: "Save acknowledgement lost" },
                { status: 503 },
              );
            }
            if (requests.at(-1) !== requests[0])
              return Response.json(
                { error: "Request changed" },
                { status: 409 },
              );
          }
          return Response.json({
            revision,
            origins,
            availableOrigins: ["https://images.unsplash.com"],
            canManage: !viewer,
            ...(request.method === "PATCH"
              ? { savedRevision: revision, replayed: true }
              : {}),
          });
        }
        return new Response(
          '<!doctype html><div id="root"></div><script src="/bundle.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    let chrome: Bun.Subprocess | undefined;
    try {
      const config = join(directory, "tsconfig.json"),
        entry = join(directory, "entry.tsx"),
        output = join(directory, "bundle.js");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            paths: {
              "@/*": [web + "/*"],
              react: [web + "/node_modules/react"],
              "react/*": [web + "/node_modules/react/*"],
            },
          },
        }),
      );
      await writeFile(
        entry,
        `import * as React from ${JSON.stringify(web + "/node_modules/react")};import {createRoot} from ${JSON.stringify(web + "/node_modules/react-dom/client")};import {PreviewMediaSettings} from ${JSON.stringify(web + "/components/workspace/artifacts/preview-media-settings.tsx")};
createRoot(document.getElementById('root')).render(<PreviewMediaSettings projectId=${JSON.stringify(project)} onRevision={revision=>document.documentElement.dataset.revision=revision}/>);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const until=async(fn)=>{const end=Date.now()+12000;while(Date.now()<end){if(fn())return;await sleep(20)}throw Error('UI state timed out')};
(async()=>{try{await until(()=>document.querySelector('input'));document.querySelector('summary').click();document.querySelector('input').click();await until(()=>Array.from(document.querySelectorAll('button')).some(b=>!b.disabled));Array.from(document.querySelectorAll('button')).find(b=>/Save media permissions|Retry the same save/.test(b.textContent)).click();await until(()=>document.body.textContent.includes('Retry the same save'));if(!document.querySelector('input').disabled)throw Error('Unknown save allowed draft edits');Array.from(document.querySelectorAll('button')).find(b=>/Save media permissions|Retry the same save/.test(b.textContent)).click();await until(()=>document.querySelector('input')?.checked&&!document.body.textContent.includes('Retry the same save'));await fetch('/viewer',{method:'POST'});await until(()=>document.body.textContent.includes('The project owner manages'));if(!document.querySelector('input').disabled||document.querySelector('button'))throw Error('Read-only controls exposed a write');await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})})}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})})}})();`,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          entry,
          "--target=browser",
          "--define",
          'process.env.NODE_ENV="production"', '--define', 'process.env.NEXT_PUBLIC_DOCS_URL=undefined',
          "--tsconfig-override",
          config,
          "--outfile",
          output,
        ],
        { cwd: web, stdout: "ignore", stderr: "pipe" },
      );
      const [code, error] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      if (code) throw new Error(error);
      bundle = await readFile(output, "utf8");
      chrome = Bun.spawn(
        [
          process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
          "--headless=new",
          "--disable-gpu",
          "--disable-background-networking",
          "--disable-sync",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          server.url.href,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 20000;
      while (result === undefined && Date.now() < deadline) await Bun.sleep(25);
      expect(result).toEqual({ ok: true });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toBe(requests[1]);
    } finally {
      chrome?.kill();
      if (chrome) await chrome.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
