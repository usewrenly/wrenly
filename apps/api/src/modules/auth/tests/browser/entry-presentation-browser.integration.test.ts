// Real entry pages and compiled CSS; controlled auth responses only.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome entry presentation", () => {
  test("sign-in reveal/error/retry, owner recovery, and styled light/dark/mobile entry states", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-entry-browser-"));
    const web = resolve(import.meta.dir, "../../../../../../web");
    const cssDirectory = join(web, ".next/static/css");
    const cssFiles = await Array.fromAsync(
      new Bun.Glob("*.css").scan({ cwd: cssDirectory }),
    );
    if (!cssFiles.length)
      throw new Error(
        "Build apps/web with --webpack before styled entry checks.",
      );
    const css = (
      await Promise.all(
        cssFiles.map((file) => readFile(join(cssDirectory, file), "utf8")),
      )
    ).join("\n");
    const captures = process.env.WRENLY_TEST_ENTRY_SCREENSHOTS
      ? resolve(process.env.WRENLY_TEST_ENTRY_SCREENSHOTS)
      : directory;
    if (captures !== directory && !captures.startsWith("/tmp/"))
      throw new Error("Entry captures must use a temporary directory.");
    await mkdir(captures, { recursive: true });
    const reports = new Map<string, { ok?: boolean; error?: string }>();
    let bundle = "",
      signIns = 0,
      recoveries = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url),
          scenario = url.searchParams.get("case") ?? "";
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "Content-Type": "text/javascript; charset=utf-8" },
          });
        if (url.pathname === "/styles.css")
          return new Response(css, {
            headers: { "Content-Type": "text/css; charset=utf-8" },
          });
        if (url.pathname === "/font.woff")
          return new Response(Bun.file(join(web, "app/fonts/GeistVF.woff")));
        if (url.pathname === "/mono.woff")
          return new Response(
            Bun.file(join(web, "app/fonts/GeistMonoVF.woff")),
          );
        if (url.pathname === "/report") {
          reports.set(
            scenario,
            (await request.json()) as { ok?: boolean; error?: string },
          );
          return new Response("ok");
        }
        if (url.pathname === "/api/instance/setup")
          return Response.json({ status: "setup-required" });
        if (url.pathname === "/api/auth/get-session")
          return Response.json({
            user: { id: "owner", email: "owner@example.test" },
          });
        if (url.pathname === "/api/auth/sign-in/email") {
          signIns++;
          if (signIns === 1)
            return Response.json(
              { message: "Check your email and password." },
              { status: 401 },
            );
          return Response.json(
            { user: { id: "owner" }, token: "fixture-token" },
            {
              headers: {
                "Set-Cookie":
                  "fixture-entry=confirmed; HttpOnly; Path=/; SameSite=Lax",
              },
            },
          );
        }
        if (url.pathname === "/api/instance/recover-owner") {
          const value = (await request.json()) as { proof: string };
          if (value.proof !== "fixture-recovery-proof")
            return Response.json({ error: "Wrong proof" }, { status: 400 });
          recoveries++;
          return Response.json({ recovered: true });
        }
        if (url.pathname === "/")
          return new Response(
            `<script>fetch('/report?case=signin',{method:'POST',body:JSON.stringify(${request.headers.get("cookie")?.includes("fixture-entry=confirmed") ? "{ok:true}" : "{error:'Missing sign-in cookie'}"})})</script>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        // Sign-in fixtures emulate an initialized instance; setup uses a distinct endpoint response via a header-free fixture bundle adapter below.
        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>@font-face{font-family:EntryGeist;src:url('/font.woff');font-weight:100 900}@font-face{font-family:EntryMono;src:url('/mono.woff');font-weight:100 900}:root{--font-geist-sans:EntryGeist;--font-geist-mono:EntryMono}</style></head><body><div id="root"></div><script>window.addEventListener('error',event=>fetch('/report?case=${scenario}',{method:'POST',body:JSON.stringify({error:event.error?.stack??event.message})}));</script><script src="/bundle.js"></script></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const navigation = join(directory, "navigation.ts");
      await writeFile(
        navigation,
        "const router={replace(path){globalThis.fixtureRoute=path}};export function useRouter(){return router}",
      );
      const entry = join(directory, "fixture.ts");
      await writeFile(
        entry,
        `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};
        import SignIn from ${JSON.stringify(join(web, "app/(auth)/sign-in/page.tsx"))};import Setup from ${JSON.stringify(join(web, "app/(auth)/setup/page.tsx"))};import Recovery from ${JSON.stringify(join(web, "app/(auth)/recover-owner/page.tsx"))};import {ThemeProvider} from ${JSON.stringify(join(web, "components/theme-provider.tsx"))};
        const query=new URLSearchParams(location.search),scenario=query.get('case');
        const originalFetch=window.fetch;window.fetch=(input,init)=>{if(String(input).endsWith('/api/instance/setup')&&location.pathname==='/sign-in')return Promise.resolve(Response.json({status:'initialized'}));return originalFetch(input,init)};
        localStorage.setItem('wrenly-theme',query.get('theme')||'light');const Page=location.pathname==='/setup'?Setup:location.pathname==='/recover-owner'?Recovery:SignIn;
        createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(ThemeProvider,null,React.createElement(Page))));
        const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const until=async (check,label='form state')=>{for(let n=0;n<500;n++){if(check())return;await sleep(10)}throw Error('Entry browser timed out: '+scenario+' / '+label)};
        const report=value=>fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify(value)});
        (async()=>{try{
          await until(()=>document.querySelector('input'));await document.fonts.ready;await sleep(30);
          if(document.documentElement.scrollWidth>innerWidth)throw Error('Horizontal page overflow '+scenario+' '+innerWidth+'/'+document.documentElement.scrollWidth+' '+Array.from(document.querySelectorAll('body *')).filter(node=>node.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(node=>node.tagName+'.'+node.className).join(','));
          const docs=document.querySelector('.entry-footer a');if(docs?.textContent!=='Read more →'||docs.href!=='http://localhost:3001/docs/guides/account-settings')throw Error('Account documentation link missing or incorrect');
          const footerText=document.querySelector('.entry-footer > span').getBoundingClientRect(),footerLink=docs.getBoundingClientRect();
          if(innerWidth>=768&&Math.abs((footerText.top+footerText.bottom)/2-(footerLink.top+footerLink.bottom)/2)>2)throw Error('Auth footer text and link are not aligned');
          if(innerWidth<=760&&getComputedStyle(document.querySelector('.entry-story')).display!=='none')throw Error('Phone retains editorial panel');
          if(getComputedStyle(document.querySelector('.entry-control')).height.replace('px','')<44)throw Error('Undersized field');
          const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
          const luminance=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const p=ctx.getImageData(0,0,1,1).data;const rgb=Array.from(p).slice(0,3).map(value=>{const n=value/255;return n<=.04045?n/12.92:Math.pow((n+.055)/1.055,2.4)});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
          const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
          const fieldStyle=getComputedStyle(document.querySelector('.entry-control'));
          if(contrast(fieldStyle.borderTopColor,fieldStyle.backgroundColor)<3)throw Error('Input border contrast below 3:1');
          if(document.documentElement.dataset.theme!==(query.get('theme')||'light'))throw Error('Stored theme not applied');
          if(query.has('visual')){if(location.hash)throw Error('Setup proof remained in URL');await report({ok:true});return;}
          if(scenario==='recovery'){if(location.hash)throw Error('Recovery proof remained in URL');Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='Confirm instance owner').click();await until(()=>document.body.textContent.includes('Instance ownership is confirmed'));await report({ok:true});return;}
          const password=document.querySelector('#password');document.querySelector('[aria-label="Show password"]').click();await until(()=>password.type==='text');document.querySelector('[aria-label="Hide password"]').click();await until(()=>password.type==='password');
          document.querySelector('#email').value='owner@example.test';password.value='fixture-password-12345';document.querySelector('form').requestSubmit();await until(()=>document.querySelector('[role=alert]'));await until(()=>document.activeElement===document.querySelector('[role=alert]'),'error focus');await until(()=>!document.querySelector('button[type=submit]').disabled);document.querySelector('form').requestSubmit();
        }catch(error){await report({error:error.message})}})();`,
      );
      const config = join(directory, "tsconfig.json");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            paths: { "@/*": [web + "/*"], "next/navigation": [navigation] },
          },
        }),
      );
      const output = join(directory, "bundle.js");
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
          'process.env.NODE_ENV="development"',
          "--define",
          "process.env.NEXT_PUBLIC_DOCS_URL=undefined",
          "--define",
          "process.env.NEXT_PUBLIC_WEB_URL=" +
            JSON.stringify(server.url.origin),
        ],
        { cwd: web, stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, diagnostic] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ]);
      if (exitCode !== 0)
        throw new Error("Entry browser fixture failed: " + diagnostic);
      bundle = await readFile(output, "utf8");
      const scenarios = [
        {
          id: "signin",
          path: "/sign-in?case=signin",
          width: 1440,
          visual: false,
        },
        {
          id: "recovery",
          path: "/recover-owner?case=recovery#recovery=fixture-recovery-proof",
          width: 1440,
          visual: false,
        },
        {
          id: "signin-light",
          path: "/sign-in?case=signin-light&visual",
          width: 1440,
          visual: true,
        },
        {
          id: "signin-dark",
          path: "/sign-in?case=signin-dark&visual&theme=dark",
          width: 1440,
          visual: true,
        },
        {
          id: "signin-mobile",
          path: "/sign-in?case=signin-mobile&visual",
          width: 390,
          visual: true,
        },
        {
          id: "signin-small",
          path: "/sign-in?case=signin-small&visual",
          width: 320,
          visual: true,
        },
        {
          id: "signin-tablet",
          path: "/sign-in?case=signin-tablet&visual",
          width: 768,
          visual: true,
        },
        {
          id: "setup-dark",
          path: "/setup?case=setup-dark&visual&theme=dark#setup=fixture-setup-proof",
          width: 1440,
          visual: true,
        },
      ];
      for (const scenario of scenarios) {
        chrome = Bun.spawn(
          [
            process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--no-first-run",
            `--user-data-dir=${join(directory, scenario.id)}`,
            `--window-size=${scenario.width},1000`,
            ...(scenario.visual
              ? [
                  "--hide-scrollbars",
                  "--virtual-time-budget=2000",
                  `--screenshot=${join(captures, scenario.id + ".png")}`,
                ]
              : []),
            server.url.origin + scenario.path,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        const deadline = Date.now() + 12_000;
        while (!reports.has(scenario.id) && Date.now() < deadline)
          await Bun.sleep(20);
        expect(reports.get(scenario.id)?.error).toBeUndefined();
        expect(reports.get(scenario.id)?.ok).toBe(true);
        if (!scenario.visual) chrome.kill();
        await chrome.exited;
        chrome = undefined;
      }
      expect(signIns).toBe(2);
      expect(recoveries).toBe(1);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
