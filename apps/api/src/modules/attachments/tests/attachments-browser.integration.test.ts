/** Exercises the shared Home/workspace upload controls in a real browser with a local fixture API. */
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const browserTest =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true" ? test : test.skip;
browserTest(
  "reference controls preserve errors, retry identity, removal and accepted selection",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-attachments-browser-"),
    );
    const web = resolve(import.meta.dir, "../../../../../web");
    let result: { ok?: boolean; error?: string } | undefined;
    const keys: string[] = [];
    let failures = 1;
    let bundle = "";
    const file = {
      id: crypto.randomUUID(),
      name: "reference.txt",
      mediaType: "text/plain",
      byteLength: 9,
      sha256: "a".repeat(64),
    };
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
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        if (url.pathname.startsWith("/api/attachments/uploads/"))
          return Response.json({ file: null });
        if (url.pathname === "/api/attachments" && request.method === "POST") {
          keys.push(request.headers.get("idempotency-key") ?? "");
          if (failures-- > 0)
            return Response.json(
              { error: "Temporary upload failure" },
              { status: 503 },
            );
          return Response.json({ file }, { status: 201 });
        }
        if (request.method === "DELETE")
          return Response.json({ removed: true });
        return new Response(
          '<div id="root"></div><script src="/bundle.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "entry.tsx");
      await writeFile(
        entry,
        `import React from '${web}/node_modules/react';
import {createRoot} from '${web}/node_modules/react-dom/client';
import {usePromptAttachments} from '${web}/components/workspace/attachments/use-prompt-attachments';
import {AttachmentList} from '${web}/components/workspace/attachments/attachment-list';
function App(){const state=usePromptAttachments();return <><button onClick={()=>state.add([new File(['Reference'],'reference.txt',{type:'text/plain'})])}>Add</button><button disabled={state.blocked||!state.ids.length} onClick={()=>state.clear()}>Send</button><AttachmentList items={state.items} disabled={false} remove={state.remove} retry={state.retry}/><output>{state.ids.join(',')}</output></>}
createRoot(document.getElementById('root')).render(<App/>);
const wait=async(fn)=>{const end=Date.now()+8000;while(!fn()){if(Date.now()>end)throw Error('Browser condition timed out');await new Promise(r=>setTimeout(r,20));}};
const button=(name)=>[...document.querySelectorAll('button')].find(b=>b.textContent===name);
(async()=>{try{await wait(()=>button('Add'));button('Add').click();await wait(()=>button('Retry'));if(!button('Send').disabled)throw Error('Failed upload allowed Send');button('Retry').click();await wait(()=>!button('Send').disabled);if(!document.querySelector('output').textContent)throw Error('Ready ID missing');document.querySelector('[aria-label="Remove reference.txt"]').click();await wait(()=>!document.querySelector('li'));if(!button('Send').disabled)throw Error('Removal retained selection');button('Add').click();await wait(()=>!button('Send').disabled);button('Send').click();await wait(()=>!document.querySelector('li'));await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});}catch(e){await fetch('/report',{method:'POST',body:JSON.stringify({error:String(e)})});}})();`,
      );
      const config = join(directory, "tsconfig.json");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            baseUrl: web,
            paths: { "@/*": ["./*"], "react/*": ["./node_modules/react/*"] },
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
          "--tsconfig-override",
          config,
          "--outdir",
          join(directory, "out"),
        ],
        { cwd: web, stdout: "ignore", stderr: "pipe" },
      );
      const diagnostics = await new Response(build.stderr).text();
      if (await build.exited) throw Error(diagnostics);
      bundle = await readFile(join(directory, "out/entry.js"), "utf8");
      chrome = Bun.spawn(
        [
          "/usr/bin/google-chrome",
          "--headless=new",
          "--disable-gpu",
          "--disable-background-networking",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          server.url.origin,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const end = Date.now() + 25000;
      while (!result && Date.now() < end) await Bun.sleep(20);
      expect(result?.error).toBeUndefined();
      expect(result?.ok).toBe(true);
      expect(keys).toHaveLength(3);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[1]);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  35000,
);
