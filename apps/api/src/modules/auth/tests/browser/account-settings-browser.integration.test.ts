import { connectPage } from "../../../../test-support/chrome-page";
import sharp from "sharp";
// Real account forms/SDK and styled settings; fixture services only.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome account settings", () => {
  test("confirmed/uncertain profile saves, password handling, theme persistence and member scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-account-browser-")),
      web = resolve(import.meta.dir, "../../../../../../web");
    const captures = process.env.WRENLY_TEST_ENTRY_SCREENSHOTS
      ? resolve(process.env.WRENLY_TEST_ENTRY_SCREENSHOTS)
      : directory;
    if (captures !== directory && !captures.startsWith("/tmp/"))
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
    if (!css) throw new Error("Build web with --webpack first.");
    let bundle = "",
      savedName = "James Kamwendo",
      role = "owner",
      profilePosts = 0,
      passwordPosts = 0,
      privateReads = 0,
      summaryError = false,
      authenticated = true;
    let staleSession = false;
    let pictureScenario = "",
      pictureWrites = 0,
      failPictureRead = false;
    const pictureIdentities: Array<string | null> = [];
    let picture: {
      userId: string;
      revision: string | null;
      mutationId: string | null;
      url: string | null;
    } = { userId: "fixture-user", revision: null, mutationId: null, url: null };
    const pictureBytes = await sharp({
      create: { width: 256, height: 256, channels: 3, background: "#799990" },
    })
      .webp()
      .toBuffer();
    const passwordChoices: boolean[] = [];
    const reports = new Map<string, { ok?: boolean; error?: string }>();
    const user = (): Record<string, unknown> => ({
      id: "fixture-user",
      name: savedName,
      email: "james@example.test",
      emailVerified: false,
      image: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "Content-Type": "text/javascript; charset=utf-8" },
          });
        if (url.pathname === "/style.css")
          return new Response(css, {
            headers: { "Content-Type": "text/css; charset=utf-8" },
          });
        if (url.pathname === "/font.woff")
          return new Response(Bun.file(join(web, "app/fonts/GeistVF.woff")));
        if (url.pathname === "/report") {
          reports.set(
            url.searchParams.get("case") ?? "",
            (await request.json()) as { ok?: boolean; error?: string },
          );
          return new Response("ok");
        }
        if (url.pathname === "/scenario") {
          summaryError = false;
          return new Response("ok");
        }
        if (url.pathname === "/api/account/profile-picture/image")
          return new Response(
            pictureScenario === "picture-fallback"
              ? "unavailable"
              : pictureBytes,
            {
              status: pictureScenario === "picture-fallback" ? 404 : 200,
              headers: { "Content-Type": "image/webp" },
            },
          );
        if (url.pathname === "/api/account/profile-picture") {
          if (request.method === "GET") {
            if (failPictureRead) {
              failPictureRead = false;
              return Response.json({ error: "unavailable" }, { status: 503 });
            }
            return Response.json(picture);
          }
          pictureWrites++;
          pictureIdentities.push(request.headers.get("idempotency-key"));
          if (pictureScenario === "picture-retry" && pictureWrites === 1)
            return Response.json({ error: "busy" }, { status: 503 });
          if (pictureScenario === "picture-conflict" && pictureWrites === 1) {
            picture = {
              userId: "fixture-user",
              revision: crypto.randomUUID(),
              mutationId: crypto.randomUUID(),
              url: "/api/account/profile-picture/image?fixture=newer",
            };
            return Response.json({ error: "changed" }, { status: 409 });
          }
          picture = {
            userId: "fixture-user",
            revision: crypto.randomUUID(),
            mutationId: request.headers.get("idempotency-key"),
            url:
              request.method === "DELETE"
                ? null
                : "/api/account/profile-picture/image?fixture=" + pictureWrites,
          };
          if (pictureScenario === "picture-uncertain" && pictureWrites === 1) {
            failPictureRead = true;
            return Response.json({ error: "ack lost" }, { status: 503 });
          }
          return Response.json(picture);
        }
        if (url.pathname === "/api/auth/get-session")
          return Response.json(
            authenticated
              ? {
                  user: user(),
                  session: {
                    id: "fixture-session",
                    userId: "fixture-user",
                    token: "fixture-only",
                    expiresAt: new Date(Date.now() + 60000).toISOString(),
                  },
                }
              : null,
          );
        if (url.pathname === "/api/instance/setup-summary")
          return summaryError
            ? Response.json({ error: "Unavailable" }, { status: 503 })
            : Response.json({
                role,
                accountConfigured: true,
                providerConfigured: true,
                hasProjects: true,
                defaultModel: {
                  state: "configured",
                  modelId: "fixture-model",
                  providerLabel: "Fixture",
                  source: "saved",
                },
                preview: "enabled",
                publishing: "operator-setup",
                connectionHealth: "not-checked",
              });
        if (url.pathname === "/api/auth/update-user") {
          profilePosts++;
          const value = (await request.json()) as { name: string };
          savedName = value.name;
          return profilePosts === 1
            ? Response.json(
                { message: "Acknowledgement unavailable", code: "UNAVAILABLE" },
                { status: 503 },
              )
            : Response.json({ status: true });
        }
        if (url.pathname === "/api/auth/change-password") {
          passwordPosts++;
          const value = (await request.json()) as {
            revokeOtherSessions: boolean;
          };
          passwordChoices.push(value.revokeOtherSessions);
          if (staleSession)
            return Response.json(
              { message: "Session is not fresh", code: "SESSION_NOT_FRESH" },
              { status: 403 },
            );
          return passwordPosts === 1
            ? Response.json(
                {
                  message: "Current password is incorrect.",
                  code: "INVALID_PASSWORD",
                },
                { status: 400 },
              )
            : passwordPosts === 2
              ? Response.json({ user: user(), token: "fixture-rotation-only" })
              : Response.json(
                  {
                    message: "Acknowledgement unavailable",
                    code: "UNAVAILABLE",
                  },
                  { status: 503 },
                );
        }
        if (url.pathname === "/api/models")
          return Response.json({
            providers: [
              {
                id: "fixture",
                label: "Fixture local service",
                kind: "local",
                reachable: true,
                displayUrl: "fixture.invalid",
                hint: null,
              },
              {
                id: "cloud-fixture",
                label: "Fixture cloud service",
                kind: "cloud",
                reachable: true,
                displayUrl: "fixture.invalid",
                hint: null,
              },
            ],
            models: [
              {
                id: "fixture-model",
                label: "Fixture model",
                provider: "fixture",
                kind: "local",
              },
              {
                id: "fixture-model",
                label: "Cloud fixture model",
                provider: "cloud-fixture",
                kind: "cloud",
              },
            ],
            envDefault: "fixture-model",
            defaultProvider: "fixture",
          });
        if (
          url.pathname === "/api/instance/legacy-projects" &&
          role === "owner"
        )
          return Response.json({ projects: [] });
        if (
          url.pathname.startsWith("/api/instance/") ||
          url.pathname.startsWith("/api/models/")
        ) {
          privateReads++;
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>@font-face{font-family:Fixture;src:url(/font.woff);font-weight:100 900}:root{--font-geist-sans:Fixture;--font-geist-mono:monospace}.fixture-header{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;border-bottom:1px solid var(--color-border);background:var(--color-surface)}</style><div id="root"></div><script type="module" src="/bundle.js"></script>',
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    let debugging: Awaited<ReturnType<typeof connectPage>> | undefined;
    try {
      const entry = join(directory, "fixture.tsx"),
        config = join(directory, "tsconfig.json"),
        navigation = join(directory, "navigation.ts"),
        link = join(directory, "link.tsx"),
        output = join(directory, "bundle.js");
      await writeFile(
        navigation,
        "export function usePathname(){return location.pathname}",
      );
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
              "next/navigation": [navigation],
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
        `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};import {QueryClient,QueryClientProvider} from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};import {ThemeProvider} from ${JSON.stringify(join(web, "components/theme-provider.tsx"))};import {AccountMenu} from ${JSON.stringify(join(web, "components/shell/account-menu.tsx"))};import SettingsLayout from ${JSON.stringify(join(web, "app/(app)/settings/layout.tsx"))};import Account from ${JSON.stringify(join(web, "app/(app)/settings/page.tsx"))};import Security from ${JSON.stringify(join(web, "app/(app)/settings/security/page.tsx"))};import Appearance from ${JSON.stringify(join(web, "app/(app)/settings/appearance/page.tsx"))};import Models from ${JSON.stringify(join(web, "app/(app)/settings/models/page.tsx"))};
const scenario=new URLSearchParams(location.search).get('case');const originalStorageRead=Storage.prototype.getItem;if(scenario==='models-storage-blocked')Storage.prototype.getItem=function(key){if(key.startsWith('wrenly:model')||key==='wrenly:provider')throw Error('Blocked model storage');return originalStorageRead.call(this,key)};if(scenario==='models-unavailable'){localStorage.setItem('wrenly:model','removed-model');localStorage.setItem('wrenly:provider','removed-provider')}if(!localStorage.getItem('wrenly-theme'))localStorage.setItem('wrenly-theme',scenario.includes('dark')?'dark':'light');const Page=location.pathname.endsWith('/security')?Security:location.pathname.endsWith('/appearance')?Appearance:location.pathname.endsWith('/models')?Models:Account;const client=new QueryClient({defaultOptions:{queries:{retry:false}}});createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider,null,React.createElement(QueryClientProvider,{client},React.createElement('header',{className:'fixture-header'},React.createElement('strong',null,'wrenly / Settings'),React.createElement(AccountMenu)),React.createElement(SettingsLayout,null,React.createElement(Page)))));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const until=async(check,label)=>{for(let i=0;i<800;i++){if(check())return;await sleep(10)}throw Error('Settings timeout: '+label+'; actual window '+window.innerWidth+'; final viewport '+innerWidth+'/'+document.documentElement.scrollWidth+'; overflow '+Array.from(document.querySelectorAll('body *')).filter(node=>node.getBoundingClientRect().right>innerWidth+1).slice(0,16).map(node=>node.tagName+'.'+node.className+' '+Math.round(node.getBoundingClientRect().right)).join(','))};const report=value=>fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify(value)});const fill=(id,value)=>{const input=document.getElementById(id);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};const text=()=>document.querySelector('.settings-content')?.textContent||'';
(async()=>{try{
 await until(()=>document.querySelector('h1')||text().includes('account could not'),'page');await document.fonts.ready;await until(()=>document.documentElement.scrollWidth<=innerWidth,'settled settings width '+scenario+' '+innerWidth+'/'+document.documentElement.scrollWidth+' '+Array.from(document.querySelectorAll('body *')).filter(node=>node.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(node=>node.tagName+'.'+node.className).join(','));
 if(document.documentElement.scrollWidth>innerWidth)throw Error('Settings overflow '+scenario+' '+innerWidth+'/'+document.documentElement.scrollWidth+' '+Array.from(document.querySelectorAll('body *')).filter(node=>node.getBoundingClientRect().right>innerWidth+1).map(node=>node.tagName+'.'+node.className).join(','));
 if(scenario.includes('member')){await until(()=>document.querySelector('.settings-navigation [aria-current]'),'member nav');if(document.querySelector('.settings-navigation a[href="/settings/providers"],.settings-navigation a[href="/settings/access"]'))throw Error('Member got admin navigation');}
 if(scenario==='summary-error'){await until(()=>document.querySelector('.settings-nav-error'),'summary error');if(!document.querySelector('#profile-name'))throw Error('Summary failure blocked profile');await fetch('/scenario');document.querySelector('.settings-nav-error button').click();await until(()=>document.querySelector('.settings-navigation a[href="/settings/providers"]'),'summary recovery');await report({ok:true});return;}
 if(scenario==='account-unsigned'){await until(()=>document.querySelector('.settings-content a[href="/sign-in"]'),'unsigned recovery');if(document.querySelector('#profile-name'))throw Error('Anonymous profile form');await report({ok:true});return;}
 if(scenario.startsWith('picture-')){
   await until(()=>document.querySelector('input[type=file]'),'picture input');
   const choose=document.querySelector('input[type=file]');
   const select=file=>{const transfer=new DataTransfer();transfer.items.add(file);choose.files=transfer.files;choose.dispatchEvent(new Event('change',{bubbles:true}));};
   const button=label=>Array.from(document.querySelectorAll('.settings-picture button')).find(node=>node.textContent===label);
   if(scenario.startsWith('picture-ready')){await until(()=>document.querySelector('.settings-picture-preview img')?.complete,'saved image loaded');await report({ok:true});return;}
   if(scenario==='picture-fallback'){await until(()=>document.querySelector('.settings-profile-avatar')?.textContent.includes('JK'),'initials fallback');await sleep(50);if(document.querySelector('.settings-picture-preview .profile-avatar img'))throw Error('Broken image did not fall back');await report({ok:true});return;}
   if(sessionStorage.getItem('picture-reloaded')){await until(()=>button('Remove picture'),'persisted picture');window.confirm=()=>true;button('Remove picture').click();await until(()=>text().includes('Picture removed.'),'removed picture');await until(()=>!document.querySelector('.app-account .profile-avatar img'),'header removal');await report({ok:true});return;}
   select(new File(['<svg/>'],'bad.svg',{type:'image/svg+xml'}));await until(()=>text().includes('smaller than 2 MiB'),'unsupported rejection');if(button('Save picture'))throw Error('Invalid file selectable');
   const canvas=document.createElement('canvas');canvas.width=12;canvas.height=12;canvas.getContext('2d').fillRect(0,0,12,12);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));select(new File([blob],'portrait.png',{type:'image/png'}));await until(()=>button('Save picture'),'preview');await until(()=>!button('Save picture').disabled,'picture metadata');await until(()=>document.querySelector('img[alt="Selected picture preview"]'),'picture preview ready');button('Save picture').click();
   if(scenario==='picture-retry'){await until(()=>text().includes('saved picture is unchanged'),'unchanged revision');if(!choose.disabled)throw Error('Uncertain upload enabled a new mutation');button('Retry this picture change').click();}
   if(scenario==='picture-uncertain'){await until(()=>text().includes('change could not be confirmed'),'uncertain picture');if(!choose.disabled||!button('Check saved picture'))throw Error('Uncertain picture allowed blind resend');button('Check saved picture').click();}
   if(scenario==='picture-conflict'){await until(()=>text().includes('changed elsewhere'),'picture conflict');if(!document.querySelector('img[alt="Selected picture preview"]'))throw Error('Conflict lost selection');await until(()=>!button('Save picture').disabled,'reviewed conflict');button('Save picture').click();}
   await until(()=>text().includes('Picture saved.'),'saved picture');await until(()=>document.querySelector('.app-account .profile-avatar img'),'header avatar refresh');if(document.querySelector('img[alt="Selected picture preview"]'))throw Error('Saved preview was not released');
   if(!sessionStorage.getItem('picture-reloaded')){sessionStorage.setItem('picture-reloaded','yes');location.reload();return;}
   window.confirm=()=>true;button('Remove picture').click();await until(()=>text().includes('Picture removed.'),'removed picture');await until(()=>!document.querySelector('.app-account .profile-avatar img'),'header removal');await report({ok:true});return;
 }
 if(Page===Account){await until(()=>document.querySelector('#profile-name'),'profile');if(!sessionStorage.getItem('profile-confirmed')){fill('profile-name','Renamed James');await sleep(30);document.querySelector('.settings-content form').requestSubmit();await until(()=>text().includes('save could not be confirmed'),'uncertain save');if(!document.querySelector('#profile-name').disabled||document.querySelector('#profile-name').value!=='Renamed James')throw Error('Unconfirmed save lost/freed draft');Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='Check saved profile').click();await until(()=>text().includes('Profile saved.'),'profile read confirmation');await until(()=>document.querySelector('[aria-label="Account menu for Renamed James"]'),'header refresh');sessionStorage.setItem('profile-confirmed','true');location.reload();return;}if(document.querySelector('#profile-name').value!=='Renamed James')throw Error('Profile did not persist after reload');}
 if(Page===Security&&scenario==='security-stale'){fill('current-password','current123');fill('new-password','newpass12');fill('confirm-password','newpass12');document.querySelector('.settings-content form').requestSubmit();await until(()=>text().includes('Sign in again before'),'sensitive-session recovery');if(!document.querySelector('.settings-content a[href="/sign-in"]')||!document.querySelector('.settings-content button[type=submit]').disabled)throw Error('Stale session lacks sign-in recovery');}
 else if(Page===Security){const submit=()=>document.querySelector('.settings-content form').requestSubmit();const passwords=(confirmation='newpass12')=>{fill('current-password','current123');fill('new-password','newpass12');fill('confirm-password',confirmation)};passwords('different12');submit();await until(()=>text().includes('do not match'),'confirmation mismatch');passwords();submit();await until(()=>text().includes('Current password is incorrect.'),'wrong password');if(Array.from(document.querySelectorAll('.settings-content input[type=password]')).some(node=>node.value))throw Error('Rejected passwords remained');passwords();submit();await until(()=>text().includes('Password changed.'),'password success');if(Array.from(document.querySelectorAll('.settings-content input[type=password]')).some(node=>node.value))throw Error('Successful passwords remained');passwords();submit();await until(()=>text().includes('could not be confirmed'),'uncertain password');if(!document.querySelector('.settings-content button[type=submit]').disabled||!document.querySelector('.settings-content a[href="/sign-in"]'))throw Error('Uncertain password allowed blind retry');if([...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>String(value).includes('newpass12')||String(value).includes('current123')))throw Error('Credentials persisted in browser storage');}
 if(Page===Appearance){await until(()=>document.querySelector('[aria-label="Color theme"]'),'theme options');const dark=Array.from(document.querySelectorAll('[aria-label="Color theme"] button')).find(node=>node.textContent.startsWith('Dark'));if(!sessionStorage.getItem('theme-checked')){dark.click();await until(()=>document.documentElement.dataset.theme==='dark','theme applies');sessionStorage.setItem('theme-checked','true');location.reload();return;}await until(()=>dark.getAttribute('aria-pressed')==='true'&&document.documentElement.dataset.theme==='dark','persisted theme');}
 if(Page===Models){
   await until(()=>document.querySelectorAll('.models-choice').length===2,'model inventory');
   if(scenario.includes('member')&&document.querySelector('.settings-content a[href="/settings/providers"]'))throw Error('Member got management card');
   document.querySelector('.models-provider-disclosure summary').click();document.querySelector('[aria-label="Connection"]').click();await until(()=>document.querySelectorAll('[role=option]').length===2,'connection choices');const providerOptions=Array.from(document.querySelectorAll('[role=option]'));const nextProvider=providerOptions[1].textContent;providerOptions[1].click();await until(()=>document.querySelector('.provider-inspector-card h3').textContent===nextProvider,'selected provider details');
   const current=()=>document.querySelector('.models-summary section').textContent;
   if(scenario==='models-unavailable'){if(!current().includes('removed-model')||!current().includes('Saved choice'))throw Error('Unavailable choice lost');}
   const choices=()=>Array.from(document.querySelectorAll('.models-choice'));
   if(scenario==='models-storage-blocked'){await until(()=>text().includes('Allow site storage'),'storage read error');Storage.prototype.getItem=originalStorageRead;const originalWrite=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='wrenly:model-selection')throw Error('Quota exceeded');return originalWrite.call(this,key,value)};choices().find(node=>node.textContent.includes('Cloud fixture model')).click();await until(()=>text().includes('Allow site storage'),'storage write error');if(localStorage.getItem('wrenly:model-selection')!==null)throw Error('Failed preference was persisted');Storage.prototype.setItem=originalWrite;}
   choices().find(node=>node.textContent.includes('Cloud fixture model')).click();
   await until(()=>JSON.parse(localStorage.getItem('wrenly:model-selection')||'null')?.provider==='cloud-fixture','provider-specific choice');
   if(JSON.parse(localStorage.getItem('wrenly:model-selection')).model!=='fixture-model')throw Error('Wrong selected identifier');
   await until(()=>current().includes('Cloud fixture model'),'selected card');
   const search=document.querySelector('.models-search input');
   const type=value=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,value);search.dispatchEvent(new Event('input',{bubbles:true}))};
   type('no-match');await until(()=>document.querySelector('.models-no-results'),'empty search');
   type('');await until(()=>choices().length===2,'clear search');
   Array.from(document.querySelectorAll('.models-filters button')).find(node=>node.textContent==='Local').click();
   await until(()=>choices().length===1,'local filter');if(choices()[0].textContent.includes('Cloud fixture model'))throw Error('Cloud leaked into local filter');
   Array.from(document.querySelectorAll('.models-summary button')).find(node=>node.textContent.includes('Use instance default')).click();
   await until(()=>current().includes('Fixture model'),'reset default');
   if(localStorage.getItem('wrenly:model-selection')!=='null')throw Error('Reset retained override');if(document.querySelector('.settings-content [role=alert]'))throw Error('Preference error did not clear after recovery');
 }

 await report({ok:true});}catch(error){await report({error:error.stack??error.message})}})();`,
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
          "--define",
          "process.env.NEXT_PUBLIC_WEB_URL=" +
            JSON.stringify(server.url.origin),
          "--tsconfig-override",
          config,
          "--outfile",
          output,
        ],
        { cwd: web, stdout: "pipe", stderr: "pipe" },
      );
      const [code, diagnostic] = await Promise.all([
        built.exited,
        new Response(built.stderr).text(),
      ]);
      if (code) throw new Error(diagnostic);
      bundle = await readFile(output, "utf8");
      for (const [name, path, width] of [
        ["picture-ready", "/settings", 1440],
        ["picture-ready-dark", "/settings", 1440],
        ["picture-ready-small", "/settings", 320],
        ["picture-retry", "/settings", 390],
        ["picture-save", "/settings", 1440],
        ["picture-uncertain", "/settings", 390],
        ["picture-conflict", "/settings", 1440],
        ["picture-member", "/settings", 390],
        ["picture-small", "/settings", 320],
        ["picture-fallback", "/settings", 390],
        ["account-desktop", "/settings", 1440],
        ["account-mobile", "/settings", 390],
        ["account-small", "/settings", 320],
        ["account-dark", "/settings", 1440],
        ["account-member", "/settings", 390],
        ["security", "/settings/security", 1440],
        ["security-stale", "/settings/security", 390],
        ["security-mobile", "/settings/security", 390],
        ["appearance", "/settings/appearance", 1440],
        ["appearance-mobile", "/settings/appearance", 390],
        ["models-member", "/settings/models", 390],
        ["models-desktop", "/settings/models", 1440],
        ["models-storage-blocked", "/settings/models", 390],
        ["models-dark", "/settings/models", 1440],
        ["models-unavailable", "/settings/models", 320],
        ["summary-error", "/settings", 1440],
        ["account-unsigned", "/settings", 390],
      ] as const) {
        pictureScenario = name;
        pictureWrites = 0;
        failPictureRead = false;
        pictureIdentities.length = 0;
        picture = {
          userId: "fixture-user",
          revision: null,
          mutationId: null,
          url: null,
        };
        if (name === "picture-fallback" || name.startsWith("picture-ready"))
          picture = {
            userId: "fixture-user",
            revision: crypto.randomUUID(),
            mutationId: crypto.randomUUID(),
            url: "/api/account/profile-picture/image?fixture=broken",
          };
        staleSession = name === "security-stale";
        savedName = "James Kamwendo";
        role = name.includes("member") ? "user" : "owner";
        profilePosts = 0;
        passwordPosts = 0;
        passwordChoices.length = 0;
        summaryError = name === "summary-error";
        authenticated = name !== "account-unsigned";
        chrome = Bun.spawn(
          [
            process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--no-first-run",
            "--hide-scrollbars",
            "--remote-debugging-port=0",
            `--user-data-dir=${join(directory, name)}`,
            `--window-size=${width},1000`,
            "about:blank",
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        debugging = await connectPage(join(directory, name));
        await debugging.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await debugging.send("Page.navigate", {
          url: `${server.url.origin}${path}?case=${name}`,
        });
        const deadline = Date.now() + 30_000;
        while (!reports.has(name) && Date.now() < deadline) await Bun.sleep(20);
        expect(reports.get(name)?.error).toBeUndefined();
        expect(reports.get(name)?.ok).toBe(true);
        const capture = await debugging.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        if (
          !capture ||
          typeof capture !== "object" ||
          !("data" in capture) ||
          typeof capture.data !== "string"
        )
          throw new Error("Invalid account fixture screenshot.");
        await writeFile(
          join(captures, name + ".png"),
          Buffer.from(capture.data, "base64"),
        );
        debugging.close();
        debugging = undefined;
        chrome.kill();
        await chrome.exited;
        chrome = undefined;
        if (name.startsWith("picture-"))
          expect(pictureWrites).toBe(
            name === "picture-fallback" || name.startsWith("picture-ready")
              ? 0
              : name === "picture-conflict" || name === "picture-retry"
                ? 3
                : 2,
          );
        if (name === "picture-retry")
          expect(pictureIdentities[0]).toBe(pictureIdentities[1]);
        if (name.startsWith("account-") && name !== "account-unsigned")
          expect(profilePosts).toBe(1);
        if (name.startsWith("security")) {
          expect(passwordPosts).toBe(staleSession ? 1 : 3);
          expect(passwordChoices).toEqual(
            staleSession ? [true] : [true, true, true],
          );
        }
      }
      expect(privateReads).toBe(0);
    } finally {
      debugging?.close();
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});
