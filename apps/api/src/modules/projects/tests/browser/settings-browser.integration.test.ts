// Real settings screen, compiled CSS and controlled persistence responses.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome project settings", () => {
  test("lost acknowledgement, same-request retry, explicit conflict review, dirty guard and reload persistence", async () => {
    const directory = await mkdtemp(
        join(tmpdir(), "wrenly-project-settings-browser-"),
      ),
      web = resolve(import.meta.dir, "../../../../../../web");
    const captures = process.env.WRENLY_TEST_ENTRY_SCREENSHOTS
      ? resolve(process.env.WRENLY_TEST_ENTRY_SCREENSHOTS)
      : directory;
    if (captures !== directory && !captures.startsWith("/tmp/"))
      throw new Error("Use /tmp for captures");
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
    const id = crypto.randomUUID(),
      stamp = new Date().toISOString();
    let saved = {
        id,
        name: "Studio",
        description: null as string | null,
        stack: "nextjs",
        access: "private",
        createdAt: stamp,
        updatedAt: stamp,
      },
      bundle = "",
      writes = 0;
    let archiveState: {
      archivedAt: string | null;
      revision: string;
      canManage: boolean;
      blockers: string[];
    } = { archivedAt: null, revision: id, canManage: true, blockers: [] };
    let archiveInputs: Array<Record<string, unknown>> = [];
    const reports = new Map<string, { ok?: boolean; error?: string }>();
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
            url.searchParams.get("case")!,
            (await request.json()) as { ok?: boolean; error?: string },
          );
          return new Response("ok");
        }
        if (url.pathname === "/external") {
          saved = { ...saved, name: "Another tab renamed this" };
          return new Response("ok");
        }
        if (url.pathname === `/api/projects/${id}/archive`) {
          if (request.method === "PATCH") {
            const input = (await request.json()) as Record<string, unknown>;
            archiveInputs.push(input);
            if (archiveInputs.length === 1) {
              archiveState = {
                ...archiveState,
                archivedAt: new Date().toISOString(),
                revision: crypto.randomUUID(),
              };
              return Response.json(
                { error: "Acknowledgement lost" },
                { status: 503 },
              );
            }
            if (input.archived === false)
              archiveState = {
                ...archiveState,
                archivedAt: null,
                revision: crypto.randomUUID(),
              };
            return Response.json({
              ...archiveState,
              savedRevision: archiveState.revision,
            });
          }
          return Response.json(archiveState);
        }
        if (url.pathname === `/api/projects/${id}/access`)
          return Response.json({
            mode: "selected",
            revision: archiveState.revision,
            archivedAt: archiveState.archivedAt,
            instanceRole: "viewer",
            capabilities: {
              role: "owner",
              read: true,
              contribute: !archiveState.archivedAt,
              manage: !archiveState.archivedAt,
              publish: !archiveState.archivedAt,
            },
            members: [],
            eligible: [],
            model: null,
          });
        if (url.pathname === `/api/projects/${id}/skills`)
          return Response.json({
            revision: archiveState.revision,
            canManage: !archiveState.archivedAt,
            selected: [],
          });
        if (url.pathname === "/api/skills")
          return Response.json({ skills: [] });
        if (url.pathname === "/api/models")
          return Response.json({ models: [], providers: [], default: null });
        if (url.pathname === `/api/projects/${id}/settings`) {
          if (request.method === "PATCH") {
            writes++;
            const input = (await request.json()) as {
              name: string;
              description: string | null;
              expected: { name: string; description: string | null };
            };
            if (
              saved.name === input.name &&
              saved.description === input.description
            )
              return Response.json({ project: saved });
            if (
              input.expected.name !== saved.name ||
              input.expected.description !== saved.description
            )
              return Response.json(
                {
                  error:
                    "Project details changed elsewhere. Review saved details.",
                  current: saved,
                },
                { status: 409 },
              );
            saved = {
              ...saved,
              name: input.name,
              description: input.description,
            };
            if (writes === 1)
              return Response.json(
                { error: "Save acknowledgement unavailable." },
                { status: 503 },
              );
            return Response.json({ project: saved });
          }
          return Response.json({ project: saved });
        }
        return new Response(
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>@font-face{font-family:Fixture;src:url(/font.woff);font-weight:100 900}:root{--font-geist-sans:Fixture;--font-geist-mono:monospace}body{font-family:Fixture}</style><div id="root"></div><script type="module" src="/bundle.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "fixture.tsx"),
        config = join(directory, "tsconfig.json"),
        link = join(directory, "link.tsx");
      await writeFile(
        link,
        `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};export default function Link(props){return React.createElement('a',props)}`,
      );
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
      await writeFile(
        entry,
        `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};import {QueryClient,QueryClientProvider} from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};import {ProjectAccessSettings} from ${JSON.stringify(join(web, "components/workspace/settings/project-sharing.tsx"))};
      const scenario=new URLSearchParams(location.search).get('case');document.documentElement.setAttribute('data-theme',scenario.includes('dark')?'dark':'light');const client=new QueryClient();client.setQueryData(['projects'],{old:true});client.setQueryData(['project',${JSON.stringify(id)}],{old:true});createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(ProjectAccessSettings,{projectId:${JSON.stringify(id)}})));
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const until=async(check,label)=>{for(let i=0;i<600;i++){if(check())return;await sleep(10)}throw Error('Settings timeout '+label)};const button=text=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent===text);const fill=(selector,value)=>{const node=document.querySelector(selector);Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))};
      (async()=>{try{await until(()=>document.querySelector('#project-name'),'load');await document.fonts.ready;
      const color=value=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');context.fillStyle=value;context.fillRect(0,0,1,1);return Array.from(context.getImageData(0,0,1,1).data).slice(0,3)};const lum=value=>{const channels=color(value).map(item=>{const s=item/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4});return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722};const contrast=(a,b)=>{const values=[lum(a),lum(b)].sort((x,y)=>x-y);return(values[1]+.05)/(values[0]+.05)};const control=getComputedStyle(document.querySelector('#project-name'));if(contrast(control.borderTopColor,control.backgroundColor)<3)throw Error('Input border contrast');if(contrast(getComputedStyle(document.querySelector('dt')).color,getComputedStyle(document.querySelector('aside')).backgroundColor)<4.5)throw Error('Project fact label contrast');
      if(document.documentElement.scrollWidth>innerWidth)throw Error('Settings overflow');if(!document.querySelector('aside').textContent.includes('Selected members')||document.querySelector('aside').textContent.includes('Private · only you'))throw Error('Incorrect confirmed project access');if(sessionStorage.getItem('complete')){if(document.querySelector('#project-name').value!=='Final studio'||document.querySelector('#project-description').value!=='A considered place for good work.')throw Error('Save did not survive reload');await until(()=>button('Archive project')&&!button('Archive project').disabled,'archive available');button('Archive project').click();await until(()=>button('Confirm archive'),'archive review');if(getComputedStyle(document.querySelector('[data-slot=dialog-content]')).backgroundColor==='rgba(0, 0, 0, 0)')throw Error('Transparent confirmation surface');if(getComputedStyle(document.querySelector('[data-slot=dialog-overlay]')).backdropFilter==='none')throw Error('Missing confirmation backdrop blur');button('Confirm archive').click();await until(()=>document.body.textContent.includes('Acknowledgement lost'),'archive uncertain');await until(()=>!button('Retry same change').disabled,'same retry enabled');button('Retry same change').click();await until(()=>document.querySelector('h1')?.textContent==='Archived project','archived page');await until(()=>button('Restore project'),'restore action');button('Restore project').click();await until(()=>button('Confirm restore'),'restore review');button('Confirm restore').click();await until(()=>document.querySelector('#project-name'),'restored settings');if(document.querySelector('#project-name').value!=='Final studio')throw Error('Restore lost saved metadata');await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({ok:true})});return;}
      if(!button('Save changes').disabled)throw Error('Pristine form can save');fill('#project-name','Unsent section draft');button('Collaboration').click();await until(()=>document.querySelector('#project-general').closest('[hidden]'),'general hidden');if(document.querySelector('#project-collaboration').hidden)throw Error('Collaboration hidden');button('General').click();await until(()=>document.querySelector('#project-collaboration').hidden,'collaboration hidden');if(document.querySelector('#project-name').value!=='Unsent section draft')throw Error('Section switch discarded draft');fill('#project-name','Updated studio');fill('#project-description','A considered place for good work.');await until(()=>!button('Save changes').disabled,'dirty');document.querySelector('form').requestSubmit();await until(()=>button('Check saved details'),'uncertain');if(document.querySelector('#project-name').value!=='Updated studio'||!document.querySelector('#project-name').disabled)throw Error('Ambiguous save lost frozen draft');if(innerWidth<700)button('Retry same save').click();else button('Check saved details').click();await until(()=>document.body.textContent.includes('Project details saved.'),'acknowledged');if(!client.getQueryState(['projects']).isInvalidated||!client.getQueryState(['project',${JSON.stringify(id)}]).isInvalidated)throw Error('Project caches not invalidated');
      await fetch('/external');fill('#project-name','Final studio');await until(()=>!button('Save changes').disabled,'second edit');document.querySelector('form').requestSubmit();await until(()=>document.querySelector('[aria-label="Review changed project details"]'),'conflict');if(document.querySelector('#project-name').value!=='Final studio')throw Error('Conflict discarded draft');button('Keep editing my draft').click();await until(()=>!button('Save changes').disabled,'reviewed');document.querySelector('form').requestSubmit();await until(()=>document.body.textContent.includes('Project details saved.'),'explicit conflict save');
      fill('#project-name','An unsaved draft');document.querySelector('.project-settings-back').click();await until(()=>document.querySelector('[role=dialog]'),'dirty guard');button('Keep editing').click();await until(()=>!document.querySelector('[role=dialog]')||document.querySelector('[role=dialog]').hasAttribute('data-closed'),'keep editing');if(document.querySelector('#project-name').value!=='An unsaved draft')throw Error('Dirty guard lost draft');fill('#project-name','Final studio');await until(()=>button('Save changes').disabled,'restore saved');sessionStorage.setItem('complete','true');location.reload();
      }catch(error){await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({error:error.message})})}})();`,
      );
      // In-memory output avoids Bun's duplicate outfile bug with this temporary TSX fixture.
      const build = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        format: "esm",
        tsconfig: config,
        plugins: [
          {
            name: "project-settings-fixture",
            setup(build) {
              build.onResolve({ filter: /^@\// }, (args) => ({
                path: Bun.resolveSync(resolve(web, args.path.slice(2)), web),
              }));
              build.onResolve({ filter: /^next\/link$/ }, () => ({
                path: link,
              }));
            },
          },
        ],
        jsx: {
          runtime: "automatic",
          importSource: join(web, "node_modules/react"),
        },
        define: {
          "process.env.NODE_ENV": '"production"',
          "process.env.NEXT_PUBLIC_DOCS_URL": "undefined",
        },
      });
      if (!build.success)
        throw new Error("Project settings browser fixture could not compile.");
      bundle = await build.outputs[0]!.text();

      for (const [name, width] of [
        ["settings-desktop", 1440],
        ["settings-mobile", 390],
        ["settings-small", 320],
        ["settings-tablet", 768],
        ["settings-dark", 1440],
      ] as const) {
        writes = 0;
        archiveState = {
          archivedAt: null,
          revision: id,
          canManage: true,
          blockers: [],
        };
        archiveInputs = [];
        saved = {
          ...saved,
          name: "Studio",
          description: name.includes("dark") ? "" : null,
        };
        chrome = Bun.spawn(
          [
            process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--no-first-run",
            "--hide-scrollbars",
            "--virtual-time-budget=9000",
            `--user-data-dir=${join(directory, name)}`,
            `--window-size=${width},1100`,
            `--screenshot=${join(captures, name + ".png")}`,
            `${server.url.origin}/p/${id}/settings?case=${name}`,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        await chrome.exited;
        chrome = undefined;
        expect(reports.get(name)?.error).toBeUndefined();
        expect(reports.get(name)?.ok).toBe(true);
        expect(writes).toBe(width < 700 ? 4 : 3);
        expect(archiveInputs).toHaveLength(3);
        expect(archiveInputs[0]).toEqual(archiveInputs[1]);
      }
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
