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
    const imageId = crypto.randomUUID();
    const deniedImageId = crypto.randomUUID();
    const docId = crypto.randomUUID();
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    );
    const wideSvgImage = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#102018"/></svg>`;
    const longImageName =
      "Quantis - Health Intelligence System Desktop App by Jack R_ for RonDesignLab very long screenshot title.jpeg";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript" },
          });
        if (url.pathname === `/api/attachments/${imageId}`)
          return new Response(wideSvgImage, {
            headers: { "content-type": "image/svg+xml" },
          });
        if (url.pathname === `/api/attachments/${deniedImageId}`)
          return new Response("Forbidden", { status: 403 });
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
          `<style>*{box-sizing:border-box}[data-slot="dialog-content"]{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:24px;width:480px;max-width:calc(100vw - 32px)}.workspace-attachment-lightbox{display:flex;flex-direction:column;width:min(48rem,calc(100vw - 2rem));max-width:min(48rem,calc(100vw - 2rem));overflow:hidden}[data-slot="dialog-header"]{min-width:0;padding-right:32px;display:flex;flex-direction:column}[data-slot="dialog-title"]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:0}[data-slot="dialog-close"]{position:absolute;top:16px;right:16px;width:28px;height:28px}.min-w-0{min-width:0}.w-full{width:100%}.max-w-full{max-width:100%}.max-h-\\[66vh\\]{max-height:66vh}.object-contain{object-fit:contain}.block{display:block}</style><div id="root"></div><script>window.addEventListener('error',e=>fetch('/report',{method:'POST',body:JSON.stringify({error:String(e.error?.stack||e.message)})}));window.addEventListener('unhandledrejection',e=>fetch('/report',{method:'POST',body:JSON.stringify({error:String(e.reason)})}));</script><script type="module" src="/bundle.js"></script>`,
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
import {SavedAttachmentList} from '${web}/components/workspace/conversation/saved-attachment-list';
const saved=${JSON.stringify([
          {
            id: imageId,
            name: longImageName,
            mediaType: "image/webp",
            byteLength: wideSvgImage.length || tinyPng.length,
            sha256: "b".repeat(64),
          },
          {
            id: deniedImageId,
            name: "private.webp",
            mediaType: "image/webp",
            byteLength: 10,
            sha256: "c".repeat(64),
          },
          {
            id: docId,
            name: "spec.md",
            mediaType: "text/markdown",
            byteLength: 24,
            sha256: "d".repeat(64),
          },
        ])};
function App(){const state=usePromptAttachments();return <><button onClick={()=>state.add([new File(['Reference'],'reference.txt',{type:'text/plain'})])}>Add</button><button disabled={state.blocked||!state.ids.length} onClick={()=>state.clear()}>Send</button><AttachmentList items={state.items} disabled={false} remove={state.remove} retry={state.retry}/><SavedAttachmentList attachments={saved}/><output>{state.ids.join(',')}</output></>}
createRoot(document.getElementById('root')).render(<App/>);
const wait=async(fn)=>{const end=Date.now()+8000;while(!fn()){if(Date.now()>end)throw Error('Browser condition timed out');await new Promise(r=>setTimeout(r,20));}};
const button=(name)=>[...document.querySelectorAll('button')].find(b=>b.textContent===name);
(async()=>{try{await wait(()=>button('Add'));button('Add').click();await wait(()=>button('Retry'));if(!button('Send').disabled)throw Error('Failed upload allowed Send');button('Retry').click();await wait(()=>!button('Send').disabled);if(!document.querySelector('output').textContent)throw Error('Ready ID missing');document.querySelector('[aria-label="Remove reference.txt"]').click();await wait(()=>!document.querySelector('[aria-label="Prompt attachments"] li'));if(!button('Send').disabled)throw Error('Removal retained selection');button('Add').click();await wait(()=>!button('Send').disabled);button('Send').click();await wait(()=>!document.querySelector('[aria-label="Prompt attachments"] li'));const previewBtn=document.querySelector('[aria-label="Preview '+${JSON.stringify(longImageName)}+'" ]')??document.querySelector('[aria-label^="Preview Quantis"]');await wait(()=>{const img=previewBtn?.querySelector('img');return Boolean(img&&img.complete&&img.naturalWidth>0);});await wait(()=>Boolean(document.querySelector('a[href="/api/attachments/${deniedImageId}"]')));if(!document.querySelector('a[href="/api/attachments/${docId}"]'))throw Error('Markdown document link missing');previewBtn.click();await wait(()=>document.querySelector('[data-slot="dialog-content"] a[href="/api/attachments/${imageId}"]'));const dialog=document.querySelector('[data-slot="dialog-content"]');const dialogImg=dialog.querySelector('img');await wait(()=>Boolean(dialogImg&&dialogImg.complete&&dialogImg.naturalWidth>0));const dialogRect=dialog.getBoundingClientRect();const imgRect=dialogImg.getBoundingClientRect();const titleRect=dialog.querySelector('[data-slot="dialog-title"]').getBoundingClientRect();const closeRect=dialog.querySelector('[data-slot="dialog-close"]').getBoundingClientRect();if(dialog.scrollWidth>dialog.clientWidth+1)throw Error('Lightbox overflows horizontally: '+dialog.scrollWidth+'>'+dialog.clientWidth);if(imgRect.right>dialogRect.right+1)throw Error('Lightbox image overflows dialog: '+imgRect.right+'>'+dialogRect.right);if(titleRect.right>closeRect.left+1)throw Error('Lightbox title overlaps close button: '+titleRect.right+'>'+closeRect.left);await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});}catch(e){await fetch('/report',{method:'POST',body:JSON.stringify({error:String(e)})});}})();`,
      );
      const config = join(directory, "tsconfig.json");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            baseUrl: web,
            paths: {
              "@/*": ["./*"],
              "react": ["./node_modules/react"],
              "react/*": ["./node_modules/react/*"],
              "react-dom": ["./node_modules/react-dom"],
              "react-dom/*": ["./node_modules/react-dom/*"],
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

browserTest(
  "image capability banner enables saved model image inputs for owners via CAS patch and guides non-owners",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-image-capability-browser-"),
    );
    const web = resolve(import.meta.dir, "../../../../../web");
    const connectionId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const initialRevision = crypto.randomUUID();
    const nextRevision = crypto.randomUUID();
    const targetModel = "qwen/qwen3.5-27b";
    let savedImageModels = ["existing-vision-model"];
    let patchPayloads: Array<Record<string, unknown>> = [];
    let result: { ok?: boolean; error?: string } | undefined;
    let bundle = "";
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
        if (url.pathname === "/api/models/connections") {
          if (request.method === "GET") {
            return Response.json({
              environment: [],
              connections: [
                {
                  id: connectionId,
                  version: versionId,
                  label: "Fixture Cloud",
                  protocol: "openai-compatible",
                  kind: "cloud",
                  endpoint: "https://provider.example/v1",
                  enabled: true,
                  catalogProviderId: null,
                  tokenConfigured: true,
                  imageModelIds: savedImageModels,
                  imageInputRevision: initialRevision,
                },
              ],
              default: null,
            });
          }
          if (request.method === "PATCH") {
            const payload = (await request.json()) as Record<string, unknown>;
            patchPayloads.push(payload);
            savedImageModels = payload.imageModelIds as string[];
            return Response.json({ imageInputRevision: nextRevision });
          }
        }
        return new Response(
          `<div id="root"></div><script>window.addEventListener('error',e=>fetch('/report',{method:'POST',body:JSON.stringify({error:String(e.error?.stack||e.message)})}));window.addEventListener('unhandledrejection',e=>fetch('/report',{method:'POST',body:JSON.stringify({error:String(e.reason)})}));</script><script type="module" src="/bundle.js"></script>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "entry.tsx");
      await writeFile(
        entry,
        `import React,{useState} from '${web}/node_modules/react';
import {createRoot} from '${web}/node_modules/react-dom/client';
import {ImageCapabilityBanner} from '${web}/components/workspace/attachments/image-capability-banner';
function App(){
  const [owner,setOwner]=useState(true);
  const [enabled,setEnabled]=useState(false);
  return <>
    <button type="button" onClick={()=>setOwner(false)}>Switch to member</button>
    <output data-testid="enabled">{String(enabled)}</output>
    <ImageCapabilityBanner
      provider="saved:${connectionId}:${versionId}"
      model="${targetModel}"
      isOwner={owner}
      onEnabled={async()=>{setEnabled(true);}}
    />
  </>;
}
createRoot(document.getElementById('root')).render(<App/>);
const wait=async(fn)=>{const end=Date.now()+8000;while(!fn()){if(Date.now()>end)throw Error('Browser condition timed out: '+document.body.textContent);await new Promise(r=>setTimeout(r,20));}};
const button=(name)=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===name);
(async()=>{try{
  await wait(()=>button('Enable image inputs'));
  button('Enable image inputs').click();
  await wait(()=>document.querySelector('[data-testid="enabled"]').textContent==='true');
  button('Switch to member').click();
  await wait(()=>!button('Enable image inputs')&&document.body.textContent.includes('Ask your instance owner'));
  await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});
}catch(e){await fetch('/report',{method:'POST',body:JSON.stringify({error:String(e)})});}})();`,
      );
      const config = join(directory, "tsconfig.json");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            baseUrl: web,
            paths: {
              "@/*": ["./*"],
              "react": ["./node_modules/react"],
              "react/*": ["./node_modules/react/*"],
              "react-dom": ["./node_modules/react-dom"],
              "react-dom/*": ["./node_modules/react-dom/*"],
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
      expect(patchPayloads).toHaveLength(1);
      expect(patchPayloads[0]).toEqual({
        id: connectionId,
        imageModelIds: ["existing-vision-model", targetModel],
        expectedImageInputRevision: initialRevision,
      });
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  35000,
);
