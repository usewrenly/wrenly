// Real React/Chrome with controlled HTTP acknowledgements; no model, external URL or operator DB.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseSkillDocument } from "./skill-document";
const integration =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome Skills library and project selection", () => {
  test("import, unknown-save reconciliation, exact retry, conflict review, archive and viewer controls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-skills-browser-")),
      web = resolve(import.meta.dir, "../../../../web");
    const css = (
      await Promise.all(
        (
          await Array.fromAsync(
            new Bun.Glob("*.css").scan({ cwd: join(web, ".next/static/css") }),
          )
        ).map((file) => readFile(join(web, ".next/static/css", file), "utf8")),
      )
    ).join("\n");
    const id = crypto.randomUUID();
    type Version = {
      id: string;
      skillId: string;
      name: string;
      description: string;
      document: string;
      sha256: string;
      source: string;
      sourceUrl: string | null;
      versionLabel: string | null;
      licenseNotes: string;
      createdAt: string;
    };
    type Row = {
      skill: {
        id: string;
        revision: string;
        currentVersionId: string;
        archivedAt: string | null;
      };
      version: Version;
    };
    const visualReports: Array<{ width: number; overflow: boolean }> = [];
    const rows: Row[] = [],
      versions: Version[] = [],
      writes: Array<Record<string, unknown>> = [],
      projectWrites: Array<Record<string, unknown>> = [];
    const acknowledgements = new Map<
      string,
      {
        skillId: string;
        savedRevision: string;
        currentRevision: string;
        versionId: string;
        replayed: boolean;
      }
    >();
    let project: {
      revision: string;
      canManage: boolean;
      selected: Array<Record<string, unknown>>;
      savedRevision?: string;
      replayed?: boolean;
    } = { revision: crypto.randomUUID(), canManage: true, selected: [] };
    let viewer = false,
      viewerLibraryReads = 0,
      bundle = "",
      result: { ok?: boolean; error?: string } | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "Content-Type": "text/javascript" },
          });
        if (url.pathname === "/styles.css")
          return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (url.pathname === "/font.woff")
          return new Response(Bun.file(join(web, "app/fonts/GeistVF.woff")));
        if (url.pathname === "/report") {
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        if (url.pathname === "/visual-report") {
          visualReports.push(
            (await request.json()) as { width: number; overflow: boolean },
          );
          return new Response("ok");
        }
        if (url.pathname === "/viewer") {
          viewer = true;
          return new Response("ok");
        }
        if (url.pathname === "/external") {
          const row = rows[0]!;
          row.skill.revision = crypto.randomUUID();
          row.version = {
            ...row.version,
            id: crypto.randomUUID(),
            document: row.version.document + "\nExternal saved change.",
            createdAt: new Date().toISOString(),
          };
          row.version.sha256 = createHash("sha256")
            .update(row.version.document)
            .digest("hex");
          row.skill.currentVersionId = row.version.id;
          versions.push(row.version);
          return new Response("ok");
        }
        if (url.pathname === `/api/projects/${id}/skills`) {
          if (request.method === "PATCH") {
            const body = (await request.json()) as Record<string, unknown>;
            projectWrites.push(body);
            if (projectWrites.length === 1) {
              project = {
                revision: crypto.randomUUID(),
                canManage: true,
                selected: rows
                  .filter((row) =>
                    (body.versionIds as string[]).includes(row.version.id),
                  )
                  .map((row) => ({
                    skillId: row.skill.id,
                    versionId: row.version.id,
                    name: row.version.name,
                    description: row.version.description,
                    document: row.version.document,
                    sha256: row.version.sha256,
                    source: row.version.source,
                    sourceUrl: row.version.sourceUrl,
                    versionLabel: row.version.versionLabel,
                    licenseNotes: row.version.licenseNotes,
                    archived: false,
                  })),
              };
              return Response.json(
                { error: "Project acknowledgement lost" },
                { status: 503 },
              );
            }
            return Response.json({
              ...project,
              savedRevision: project.revision,
              replayed: true,
            });
          }
          return Response.json({ ...project, canManage: !viewer });
        }
        if (url.pathname.startsWith("/api/skills")) {
          if (viewer) {
            viewerLibraryReads++;
            return Response.json(
              { error: "Not your library" },
              { status: 403 },
            );
          }
          const parts = url.pathname.split("/");
          if (parts[4] === "actions")
            return Response.json(acknowledgements.get(parts[5]!) ?? null);
          if (request.method === "POST" || request.method === "PATCH") {
            const body = (await request.json()) as Record<string, unknown>;
            writes.push(body);
            const prior = acknowledgements.get(String(body.requestId));
            if (prior) return Response.json({ ...prior, replayed: true });
            const skillId = String(body.skillId ?? parts[3]),
              current = rows.find((row) => row.skill.id === skillId);
            if (current && body.expectedRevision !== current.skill.revision)
              return Response.json(
                { error: "Skill changed; reload and compare." },
                { status: 409 },
              );
            let row = current;
            if (body.kind === "archive") {
              row!.skill = {
                ...row!.skill,
                revision: crypto.randomUUID(),
                archivedAt: body.archived ? new Date().toISOString() : null,
              };
            } else {
              const parsed = parseSkillDocument(body.document),
                version: Version = {
                  id: crypto.randomUUID(),
                  skillId,
                  name: parsed.name,
                  description: parsed.description,
                  document: parsed.document,
                  sha256: parsed.sha256,
                  source: String(body.source),
                  sourceUrl: body.sourceUrl as string | null,
                  versionLabel: body.versionLabel as string | null,
                  licenseNotes: String(body.licenseNotes),
                  createdAt: new Date().toISOString(),
                };
              versions.push(version);
              if (row) {
                row.version = version;
                row.skill = {
                  ...row.skill,
                  revision: crypto.randomUUID(),
                  currentVersionId: version.id,
                };
              } else {
                row = {
                  skill: {
                    id: skillId,
                    revision: crypto.randomUUID(),
                    currentVersionId: version.id,
                    archivedAt: null,
                  },
                  version,
                };
                rows.push(row);
              }
            }
            const ack = {
              skillId,
              savedRevision: row!.skill.revision,
              currentRevision: row!.skill.revision,
              versionId: row!.version.id,
              replayed: false,
            };
            acknowledgements.set(String(body.requestId), ack);
            if (writes.length === 1 || writes.length === 2)
              return Response.json(
                { error: "Acknowledgement lost" },
                { status: 503 },
              );
            return Response.json(ack);
          }
          if (parts[3])
            return Response.json({
              skill: rows[0]!.skill,
              versions: [...versions].reverse(),
              historyLimit: 50,
            });
          return Response.json({ skills: rows });
        }
        return new Response(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>@font-face{font-family:Fixture;src:url(/font.woff);font-weight:100 900}:root{--font-geist-sans:Fixture;--font-geist-mono:monospace}body{font-family:Fixture;padding:36px;max-width:1250px;margin:auto;background:var(--color-bg);color:var(--color-text)}</style></head><body><main id="root"></main><script>addEventListener('error',e=>fetch('/report',{method:'POST',body:JSON.stringify({error:e.error?.stack??e.message})}));addEventListener('unhandledrejection',e=>fetch('/report',{method:'POST',body:JSON.stringify({error:String(e.reason)})}));</script><script type="module" src="/bundle.js"></script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "fixture.ts"),
        config = join(directory, "tsconfig.json"),
        output = join(directory, "output/fixture.js"),
        link = join(directory, "link.ts");
      await writeFile(
        link,
        "import React from " +
          JSON.stringify(join(web, "node_modules/react/index.js")) +
          ';export default function Link({href,children,...props}){return React.createElement("a",{...props,href},children)}',
      );
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
              "next/link": [link],
            },
          },
        }),
      );
      await writeFile(
        entry,
        `
import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};
import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};
import {QueryClient,QueryClientProvider} from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};
import {SkillsLibrary} from ${JSON.stringify(join(web, "components/settings/skills/skills-library.tsx"))};
import {ProjectSkills} from ${JSON.stringify(join(web, "components/workspace/settings/project-skills.tsx"))};
const viewer=new URLSearchParams(location.search).has('viewer');
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(React.Fragment,null,!viewer&&React.createElement(SkillsLibrary),React.createElement(ProjectSkills,{projectId:${JSON.stringify(id)}}))));
const wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async(fn,label)=>{for(let n=0;n<700;n++){if(fn())return;await wait(10)}throw Error(label+': '+document.body.textContent)};
const button=text=>Array.from(document.querySelectorAll('button')).find(node=>(node.getAttribute('aria-label')||node.textContent)===text);
const fill=(node,value)=>{Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))};
const close=()=>until(()=>!document.querySelector('[role=dialog][data-open]'),'dialog closed');
(async()=>{try{
if(new URLSearchParams(location.search).has('visual')){await until(()=>document.querySelector('.skill-library-row'),'visual library');document.querySelector('.skill-library-row').click();await wait(200);await fetch('/visual-report',{method:'POST',body:JSON.stringify({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth})});return;}
if(viewer){await until(()=>document.querySelector('.project-skill-content'),'shared guidance');if(button('Save project skills')||document.querySelector('.project-skill-choice'))throw Error('Viewer received owner controls');if(!document.body.textContent.includes('tone-guide'))throw Error('Shared skill missing');await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});return;}
await until(()=>document.querySelector('#skill-document'),'library editor');
const imported='---\\nname: tone-guide\\ndescription: Clear product language\\n---\\nUse concise labels.';
const transfer=new DataTransfer();transfer.items.add(new File([imported],'SKILL.md',{type:'text/markdown'}));const upload=document.querySelector('[aria-label="Import SKILL.md"]');upload.files=transfer.files;upload.dispatchEvent(new Event('change',{bubbles:true}));
await until(()=>document.querySelector('#skill-document').value===imported,'imported text');button('Save skill').click();await until(()=>button('Check saved change'),'unknown create');if(!document.querySelector('#skill-document').readOnly)throw Error('Unknown save remained editable');button('Check saved change').click();await until(()=>button('Save new version')&&button('Save new version').disabled,'confirmed creation');
const changed=imported+'\\nPrefer active verbs.';fill(document.querySelector('#skill-document'),changed);await until(()=>button('Save new version')&&!button('Save new version').disabled,'dirty edit');button('Save new version').click();await until(()=>button('Retry same save'),'unknown edit');button('Retry same save').click();await until(()=>document.querySelector('.skill-edit-actions').textContent.includes('Ready to review'),'exact retry acknowledged');
const retained=changed+'\\nKeep my unsaved draft.';fill(document.querySelector('#skill-document'),retained);await fetch('/external');await until(()=>button('Save new version')&&!button('Save new version').disabled,'dirty after external edit');button('Save new version').click();await until(()=>button('Reload and compare'),'conflict');if(document.querySelector('#skill-document').value!==retained)throw Error('Conflict erased draft');button('Reload and compare').click();await until(()=>document.querySelector('[role=dialog][data-open]'),'review dialog');button('Discard draft and continue').click();await close();await until(()=>document.querySelector('#skill-document').value.includes('External saved change.'),'explicit reload');
button('Archive').click();await until(()=>document.querySelector('[role=dialog][data-open]'),'archive confirmation');button('Archive skill').click();await close();await until(()=>button('Restore'),'archived');button('Restore').click();await until(()=>document.querySelector('[role=dialog][data-open]'),'restore confirmation');button('Restore skill').click();await close();await until(()=>button('Archive')&&!button('Archive').disabled,'restored');
await until(()=>document.querySelector('.project-skill-choice input'),'project library choices');document.querySelector('.project-skill-choice input').click();await until(()=>!button('Save project skills').disabled,'project selection dirty');button('Save project skills').click();await until(()=>button('Check / retry same selection'),'unknown project selection');if(!document.querySelector('.project-skill-choice input').disabled)throw Error('Unknown selection remained mutable');button('Check / retry same selection').click();await until(()=>document.body.textContent.includes('Project skills saved.'),'project saved');
await fetch('/viewer');location.href='/?viewer';
}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.stack??error.message})})}})();`,
      );
      const build = Bun.spawn(
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
          "--outdir",
          join(directory, "output"),
        ],
        { cwd: web, stdout: "ignore", stderr: "pipe" },
      );
      const [code, diagnostics] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ]);
      if (code) throw Error(diagnostics);
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
          "--window-size=1440,1100",
          `--user-data-dir=${join(directory, "profile")}`,
          server.url.origin,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 35000;
      while (!result && Date.now() < deadline) await Bun.sleep(20);
      expect(result?.error).toBeUndefined();
      expect(result?.ok).toBe(true);
      expect(writes[0]?.source).toBe("imported");
      expect(writes[1]?.requestId).toBe(writes[2]?.requestId);
      expect(writes[1]).toEqual(writes[2]);
      expect(rows).toHaveLength(1);
      expect(versions).toHaveLength(3);
      expect(projectWrites).toHaveLength(2);
      expect(projectWrites[0]).toEqual(projectWrites[1]);
      expect(viewerLibraryReads).toBe(0);
      if (process.env.WRENLY_TEST_ENTRY_SCREENSHOTS) {
        const captures = resolve(process.env.WRENLY_TEST_ENTRY_SCREENSHOTS);
        if (!captures.startsWith("/tmp/"))
          throw new Error("Use /tmp for captures");
        await mkdir(captures, { recursive: true });
        viewer = false;
        for (const width of [1440, 390]) {
          const capture = Bun.spawn(
            [
              process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
              "--headless=new",
              "--disable-gpu",
              "--disable-background-networking",
              "--no-first-run",
              `--user-data-dir=${join(directory, "visual-" + width)}`,
              `--window-size=${width},1100`,
              "--hide-scrollbars",
              "--virtual-time-budget=3000",
              `--screenshot=${join(captures, "skills-" + width + ".png")}`,
              `${server.url.origin}/?visual`,
            ],
            { stdout: "ignore", stderr: "ignore" },
          );
          expect(await capture.exited).toBe(0);
        }
        expect(visualReports).toHaveLength(2);
        expect(visualReports.every((report) => !report.overflow)).toBe(true);
      }
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 45000);
});
