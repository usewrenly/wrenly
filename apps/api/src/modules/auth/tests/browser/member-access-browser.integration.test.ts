// Actual member controls, fixture authority and canonical avatar route only.
import { expect, test, describe } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome member access management", () => {
  test("confirmation, lost acknowledgement, exact retry, conflict review and protected owner across phone/dark", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-member-ui-")),
      web = resolve(import.meta.dir, "../../../../../../web");
    const captures = process.env.WRENLY_TEST_ENTRY_SCREENSHOTS
      ? resolve(process.env.WRENLY_TEST_ENTRY_SCREENSHOTS)
      : directory;
    if (captures !== directory && !captures.startsWith("/tmp/"))
      throw Error("Use temporary screenshot directory.");
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
    let bundle = "",
      scenario = "",
      writes = 0,
      reads = 0,
      suspended = false,
      revision = crypto.randomUUID(),
      record: Record<string, unknown> | null = null,
      failRead = false;
    const identities: string[] = [];
    const reports = new Map<string, { ok?: boolean; error?: string }>();
    const members = () => [
      {
        id: "owner",
        userId: "owner-user",
        name: "James Owner",
        email: "owner@example.test",
        role: "owner",
        suspended: false,
        accessRevision: crypto.randomUUID(),
      },
      {
        id: "member",
        userId: "member-user",
        name: "Alex Member",
        email: "alex@example.test",
        role: "member",
        suspended,
        accessRevision: revision,
      },
    ];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "Content-Type": "text/javascript;charset=utf-8" },
          });
        if (url.pathname === "/style.css")
          return new Response(css, {
            headers: { "Content-Type": "text/css;charset=utf-8" },
          });
        if (url.pathname === "/font.woff")
          return new Response(Bun.file(join(web, "app/fonts/GeistVF.woff")));
        if (url.pathname === "/report") {
          reports.set(
            scenario,
            (await request.json()) as { ok?: boolean; error?: string },
          );
          return new Response("ok");
        }
        if (url.pathname === "/fixture/members")
          return Response.json(members());
        if (url.pathname === "/api/instance/access/actions") {
          writes++;
          const body = (await request.json()) as {
            requestId: string;
            action: string;
            targetId: string;
          };
          identities.push(body.requestId);
          if (scenario.includes("retry") && writes === 1)
            return Response.json(
              { error: "Temporary failure" },
              { status: 503 },
            );
          if (scenario.includes("block"))
            return Response.json(
              {
                error:
                  "Builds are queued or running. Finish or cancel the work, then review again.",
              },
              { status: 409 },
            );
          suspended = body.action === "suspend";
          revision = crypto.randomUUID();
          record = { ...body, revision };
          if (scenario.includes("later")) {
            suspended = false;
            revision = crypto.randomUUID();
          }
          if (scenario.includes("uncertain") && writes === 1) {
            failRead = true;
            return Response.json(
              { error: "Acknowledgement lost" },
              { status: 503 },
            );
          }
          return Response.json(record);
        }
        if (url.pathname.startsWith("/api/instance/access/actions/")) {
          reads++;
          if (failRead) {
            failRead = false;
            return Response.json({ error: "Unavailable" }, { status: 503 });
          }
          return Response.json({
            action: record,
            current: { revision, suspended },
          });
        }
        return new Response(
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>@font-face{font-family:Fixture;src:url(/font.woff)}body{font-family:Fixture;background:var(--color-bg);color:var(--color-text-1)}main{max-width:700px;margin:60px auto;padding:20px}h1{font-size:28px;margin-bottom:24px}</style></head><body><main><h1>Instance access</h1><div id="root"></div></main><script type="module" src="/bundle.js"></script></body></html>',
          { headers: { "Content-Type": "text/html;charset=utf-8" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "fixture.tsx"),
        config = join(directory, "tsconfig.json"),
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
      await writeFile(
        entry,
        `import React,{useState} from ${JSON.stringify(join(web, "node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};import {QueryClient,QueryClientProvider} from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};import {MemberAccessManager} from ${JSON.stringify(join(web, "components/settings/access/member-access-manager.tsx"))};
const scenario=new URLSearchParams(location.search).get('case');document.documentElement.dataset.theme=scenario.includes('dark')?'dark':'light';const initial=await(await fetch('/fixture/members')).json();function Fixture(){const [members,setMembers]=useState(initial);return React.createElement(MemberAccessManager,{members,onRefresh:async()=>setMembers(await(await fetch('/fixture/members')).json())})}createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(Fixture)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const until=async(fn,label)=>{for(let i=0;i<600;i++){if(fn())return;await sleep(10)}throw Error('Timeout '+label)};const button=label=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent===label);const text=()=>document.body.textContent;const report=value=>fetch('/report',{method:'POST',body:JSON.stringify(value)});
(async()=>{try{await until(()=>button('Suspend access'),'member list');await document.fonts.ready;if(document.documentElement.scrollWidth>innerWidth)throw Error('Member overflow');if(document.querySelectorAll('.member-management-row:first-child button').length)throw Error('Owner has suspend action');button('Suspend access').click();await until(()=>button('Confirm suspension'),'review');if(!text().includes('Projects, credentials and history will not be deleted'))throw Error('Missing ownership explanation');button('Cancel').click();await until(()=>!button('Confirm suspension'),'cancel dismissed');button('Suspend access').click();await until(()=>button('Confirm suspension'),'second review');button('Confirm suspension').click();
if(scenario.includes('uncertain')){await until(()=>button('Check saved access'),'uncertain recovery');await until(()=>!button('Check saved access').disabled,'recovery available');if(!button('Suspend access').disabled)throw Error('Uncertain access allowed another action');button('Check saved access').click();await until(()=>text().includes('Unavailable')||text().includes('Member access suspended.'),'read result');if(text().includes('Unavailable')){await until(()=>!button('Check saved access').disabled,'read retry ready');button('Check saved access').click();}}
if(scenario.includes('retry')){await until(()=>button('Check saved access')&&!button('Check saved access').disabled,'retry read');button('Check saved access').click();await until(()=>button('Retry this access change'),'explicit retry');button('Retry this access change').click();}
if(scenario.includes('block')){await until(()=>text().includes('Builds are queued'),'work blocker');button('Check saved access').click();await until(()=>button('Reload and review'),'review recovery');button('Reload and review').click();await until(()=>!button('Check saved access'),'recovered');if(!button('Suspend access')||button('Restore access'))throw Error('Blocked action changed status');await report({ok:true});return;}
if(scenario.includes('later')){await until(()=>text().includes('changed again'),'newer action');if(text().includes('Member access suspended.'))throw Error('Old audit claimed current suspension');await report({ok:true});return;}
await until(()=>text().includes('Member access suspended.'),'suspended');if(!button('Restore access'))throw Error('Restore action missing');if(!scenario.includes('visual')){button('Restore access').click();await until(()=>button('Confirm restore'),'restore review');button('Confirm restore').click();await until(()=>text().includes('Member access restored.'),'restored');}await report({ok:true});}catch(error){await report({error:error.stack??error.message})}})();`,
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
        { stdout: "ignore", stderr: "pipe" },
      );
      const diagnostic = await new Response(built.stderr).text();
      if (await built.exited) throw Error(diagnostic);
      bundle = await readFile(output, "utf8");
      for (const [name, width] of [
        ["member-visual", 1440],
        ["member-visual-dark", 1440],
        ["member-visual-small", 320],
        ["member-uncertain", 390],
        ["member-retry", 390],
        ["member-block", 390],
        ["member-later", 1440],
      ] as const) {
        scenario = name;
        writes = 0;
        reads = 0;
        suspended = false;
        revision = crypto.randomUUID();
        record = null;
        failRead = false;
        identities.length = 0;
        chrome = Bun.spawn(
          [
            process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--no-first-run",
            "--virtual-time-budget=10000",
            `--user-data-dir=${join(directory, name)}`,
            `--window-size=${width},1000`,
            `--screenshot=${join(captures, name + ".png")}`,
            `${server.url.origin}/?case=${name}`,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        await chrome.exited;
        chrome = undefined;
        expect(reports.get(name)?.error).toBeUndefined();
        expect(reports.get(name)?.ok).toBe(true);
        expect(writes).toBe(
          name.includes("visual") ||
            name.includes("block") ||
            name.includes("later")
            ? 1
            : name.includes("retry")
              ? 3
              : 2,
        );
        expect(reads).toBeGreaterThan(0);
        if (name.includes("retry")) expect(identities[0]).toBe(identities[1]);
      }
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});
