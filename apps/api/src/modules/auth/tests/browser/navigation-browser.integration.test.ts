// Real navigation primitives, compiled app CSS and fixture-only services.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome application navigation", () => {
  test("desktop shortcut/filter/error recovery and sign-out; mobile focus containment, Escape and responsive search", async () => {
    const directory = await mkdtemp(
        join(tmpdir(), "wrenly-navigation-browser-"),
      ),
      web = resolve(import.meta.dir, "../../../../../../web");
    const cssFiles = await Array.fromAsync(
      new Bun.Glob("*.css").scan({ cwd: join(web, ".next/static/css") }),
    );
    if (!cssFiles.length)
      throw new Error(
        "Build apps/web with --webpack before styled navigation checks.",
      );
    const css = (
      await Promise.all(
        cssFiles.map((file) =>
          readFile(join(web, ".next/static/css", file), "utf8"),
        ),
      )
    ).join("\n");
    const captures = process.env.WRENLY_TEST_ENTRY_SCREENSHOTS
      ? resolve(process.env.WRENLY_TEST_ENTRY_SCREENSHOTS)
      : directory;
    if (captures !== directory && !captures.startsWith("/tmp/"))
      throw new Error("Navigation captures must use a temporary directory.");
    await mkdir(captures, { recursive: true });
    const reports = new Map<string, { ok?: boolean; error?: string }>();
    let bundle = "",
      failureStatus = 0,
      signOuts = 0,
      projectCreates = 0;
    const initialSkillId = "00000000-0000-4000-8000-000000000081", initialVersionId = "00000000-0000-4000-8000-000000000082";
    const createBodies: Array<{ skillVersionIds?: string[] }> = [];
    let onboarding = false,
      summaryRole: "owner" | "user" = "owner",
      summaryFailure = false,
      memberFailure = false,
      unauthorizedMemberReads = 0;
    let collection = false,
      homeMany = false,
      setupComplete = false;
    const projects = [
      {
        id: crypto.randomUUID(),
        name: "Studio booking",
        stack: "nextjs",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        latestBuild: {
          status: "success",
          deployedUrl: "https://example.test",
          attemptCount: 1,
        },
      },
      {
        id: crypto.randomUUID(),
        name: "Field notes",
        stack: "laravel",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        latestBuild: { status: "failed", deployedUrl: null, attemptCount: 3 },
      },
    ].map(project => ({ ...project, latestBuild: {
      id: crypto.randomUUID(), createdAt: project.createdAt, ...project.latestBuild,
    } }));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
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
            url.searchParams.get("case") ?? "",
            (await request.json()) as { ok?: boolean; error?: string },
          );
          return new Response("ok");
        }
        if (url.pathname === "/scenario") {
          failureStatus = url.searchParams.has("error")
            ? 503
            : url.searchParams.has("session")
              ? 401
              : 0;
          if (url.searchParams.has("summary-ready")) summaryFailure = false;
          return new Response("ok");
        }
        if (url.pathname === "/api/instance/setup-summary")
          return summaryFailure
            ? Response.json({ error: "Unavailable" }, { status: 503 })
            : Response.json({
                role: summaryRole,
                accountConfigured: true,
                providerConfigured: setupComplete,
                defaultModel: {
                  state: setupComplete ? "configured" : "missing",
                  modelId: null,
                  providerLabel: null,
                  source: null,
                },
                hasProjects: setupComplete,
                preview: "operator-setup",
                publishing: "operator-setup",
                connectionHealth: "not-checked",
              });
        if (url.pathname === "/api/projects" && request.method === "GET")
          return failureStatus !== 0
            ? Response.json({ error: "Unavailable" }, { status: failureStatus })
            : Response.json({
                projects: onboarding
                  ? []
                  : collection || homeMany
                    ? Array.from({ length: 30 }, (_, index) => ({
                        ...projects[index % 2],
                        id: `project-${index}`,
                        name: `Project ${String(index).padStart(2, "0")}`,
                        description: index === 0 ? "Unique description" : null,
                      }))
                    : projects,
              });
        if (url.pathname === "/api/auth/get-session")
          return Response.json({
            user: { id: "owner", name: "James", email: "owner@example.test" },
            session: {
              id: "fixture",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          });
        if (url.pathname === "/api/instance/access/members") {
          if (summaryRole !== "owner") unauthorizedMemberReads++;
          if (memberFailure) {
            memberFailure = false;
            return Response.json({ error: "Unavailable" }, { status: 503 });
          }
          return Response.json({
            members: [
              { id: "owner", name: "James" },
              { id: "member", name: "Ada Lovelace" },
            ],
            invitations: [],
          });
        }
        if (url.pathname === "/api/models")
          return Response.json({
            providers: [
              {
                id: "fixture",
                label: "Fixture model service",
                kind: "local",
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
            ],
            envDefault: "fixture-model",
            defaultProvider: "fixture",
          });
        if (url.pathname === "/api/skills") return Response.json({ skills: [{ skill: { id: initialSkillId, revision: initialSkillId, currentVersionId: initialVersionId, archivedAt: null }, version: { id: initialVersionId, skillId: initialSkillId, name: "clear-copy", description: "Use clear interface text", document: "---\nname: clear-copy\ndescription: Use clear interface text\n---\nUse concrete verbs.", sha256: "fixture", source: "authored", sourceUrl: null, versionLabel: null, licenseNotes: "", createdAt: new Date().toISOString() } }] });
        if (url.pathname === "/api/projects" && request.method === "POST") {
          createBodies.push(await request.json());
          projectCreates++;
          return projectCreates === 1
            ? Response.json({ message: "Unavailable" }, { status: 503 })
            : Response.json({ project: { id: "fixture-created" } });
        }
        if (url.pathname === "/api/auth/sign-out") {
          signOuts++;
          return signOuts === 1
            ? Response.json({ message: "Unavailable" }, { status: 503 })
            : Response.json({ success: true });
        }
        if (url.pathname === "/sign-in")
          return new Response(
            "<script>fetch('/report?case=desktop',{method:'POST',body:JSON.stringify({ok:true})})</script>",
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        if (/^\/connectors\/(figma|github|coolify)\.svg$/.test(url.pathname))
          return new Response(Bun.file(join(web, "public", url.pathname)), {
            headers: { "Content-Type": "image/svg+xml" },
          });
        const scenario = url.searchParams.get("case") ?? "";
        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>@font-face{font-family:FixtureGeist;src:url('/font.woff');font-weight:100 900}@font-face{font-family:FixtureMono;src:url('/mono.woff');font-weight:100 900}:root{--font-geist-sans:FixtureGeist;--font-geist-mono:FixtureMono}</style></head><body><div id="root"></div><script>window.addEventListener('error',event=>fetch('/report?case=${scenario}',{method:'POST',body:JSON.stringify({error:event.error?.cause?.stack??event.error?.stack??event.message})}));</script><script type="module" src="/bundle.js"></script></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const navigation = join(directory, "navigation.ts"),
        link = join(directory, "link.ts"),
        config = join(directory, "tsconfig.json"),
        entry = join(directory, "fixture.ts"),
        output = join(directory, "bundle.js");
      await writeFile(
        navigation,
        "export function usePathname(){return location.pathname};export function useRouter(){return {push(path){window.fixtureRoute=path}}}",
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
        `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};import {QueryClient,QueryClientProvider} from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};import {Shell} from ${JSON.stringify(join(web, "components/shell/shell.tsx"))};import {ThemeProvider} from ${JSON.stringify(join(web, "components/theme-provider.tsx"))};
        import {Dashboard} from ${JSON.stringify(join(web, "components/dashboard/dashboard.tsx"))};
        import {ProjectsCollection} from ${JSON.stringify(join(web, "components/dashboard/projects-collection.tsx"))};
        import GetStarted from ${JSON.stringify(join(web, "app/(app)/get-started/page.tsx"))};
        const query=new URLSearchParams(location.search),scenario=query.get('case');localStorage.setItem('wrenly-theme',query.has('dark')?'dark':'light');const client=new QueryClient();createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider,null,React.createElement(QueryClientProvider,{client},React.createElement(Shell,null,scenario.startsWith('projects')?React.createElement(ProjectsCollection):scenario.startsWith('onboarding')?React.createElement(GetStarted):scenario.startsWith('home')?React.createElement(Dashboard):React.createElement('div',{style:{padding:'32px'}},React.createElement('h1',null,'Your workspace'),React.createElement('p',null,'Navigation acceptance fixture. Project and account data use controlled services.'))))));
        const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const until=async(check,label='state')=>{for(let n=0;n<700;n++){if(check())return;await sleep(10)}throw Error('Navigation timeout: '+label)};const report=value=>fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify(value)});
        const fill=(node,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))};
        (async()=>{try{

          if(scenario.startsWith('projects')){
            await until(()=>document.querySelectorAll('.project-card').length===24);await document.fonts.ready;
            if(document.documentElement.scrollWidth>innerWidth)throw Error('Collection overflow');
            if(document.querySelector('.project-card a a,.project-card a button'))throw Error('Nested card controls');
            if(!document.querySelector('.project-card footer a').getAttribute('href').endsWith('/settings'))throw Error('Missing settings route');
            if(query.has('visual')){await report({ok:true});return;}
            document.querySelector('.projects-more').click();await until(()=>document.querySelectorAll('.project-card').length===30);
            const search=document.querySelector('[aria-label="Search your projects"]');fill(search,'unique description');await until(()=>document.querySelectorAll('.project-card').length===1);
            fill(search,'absent');await until(()=>document.querySelector('.home-empty'));document.querySelector('.home-empty button').click();await until(()=>document.querySelectorAll('.project-card').length===24);
            const choose=async(label,text)=>{document.querySelector('[aria-label="'+label+'"]').click();await until(()=>document.querySelector('[role=option]'));Array.from(document.querySelectorAll('[role=option]')).find(node=>node.textContent===text).click();await sleep(50)};
            await choose('Filter projects','Failed');await until(()=>document.querySelectorAll('.project-card').length===15);
            await choose('Filter framework','Next.js');await until(()=>document.querySelector('.home-empty'));document.querySelector('.home-empty button').click();await until(()=>document.querySelectorAll('.project-card').length===24);
            await choose('Sort projects','Name A–Z');if(document.querySelector('.project-card h2').textContent!=='Project 00')throw Error('Sort failed');
            await fetch('/scenario?session');await client.invalidateQueries({queryKey:['projects']});await until(()=>document.querySelector('.projects-page a[href="/sign-in"]'));
            await fetch('/scenario?error');await client.invalidateQueries({queryKey:['projects']});await until(()=>document.querySelector('.projects-page [role=alert] button'));await fetch('/scenario');document.querySelector('.projects-page [role=alert] button').click();await until(()=>document.querySelectorAll('.project-card').length===24);
            await report({ok:true});return;
          }
          if(scenario.startsWith('home')){
            await until(()=>document.querySelectorAll('.home-project-row').length===(scenario==='home-many'?4:2));await document.fonts.ready;
            if(document.documentElement.scrollWidth>innerWidth)throw Error('Dashboard overflows viewport '+innerWidth+'/'+document.documentElement.scrollWidth+' '+Array.from(document.querySelectorAll('body *')).filter(node=>node.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(node=>node.tagName+'.'+node.className).join(','));
            if(document.querySelector('.home-page a a,.home-page button a,.home-page a button'))throw Error('Nested dashboard controls');
            if(innerWidth<1024&&scenario!=='home-user'){document.querySelector('[aria-label="Open navigation"]').click();await until(()=>document.querySelector('.app-rail-setup .home-progress-card'));}if(scenario!=='home-complete'&&scenario!=='home-user')await until(()=>document.querySelector('.home-progress-card [role=progressbar]'));if(scenario==='home-complete'||scenario==='home-user'){if(document.querySelector('.home-progress-card'))throw Error('Unactionable setup card');}else if(!document.querySelector('.home-progress-card [role=progressbar]')||document.querySelector('.home-progress-card [role=progressbar]').getAttribute('aria-valuenow')!=='1')throw Error('Incorrect saved progress');if(Boolean(document.querySelector('.home-project-continuation'))!==(scenario==='home-many'))throw Error('Incorrect continuation cue');const setupCard=document.querySelector('.home-progress-card');if(setupCard){const slot=setupCard.closest('.app-rail-setup');if(!slot||slot.nextElementSibling?.className!=='app-rail-footer')throw Error('Setup guidance must precede sidebar settings');if(document.querySelector('.home-page .home-progress-card'))throw Error('Setup guidance remains on Home');}if(scenario!=='home-user')await until(()=>document.querySelector('[aria-label="Invite others"]'));if(scenario==='home-members-error'){await until(()=>document.querySelector('.app-member-retry'));if(document.querySelector('.app-member-stack .app-avatar'))throw Error('Failed directory invented members');document.querySelector('.app-member-retry').click();}if(scenario!=='home-user')await until(()=>document.querySelectorAll('.app-member-stack .app-avatar').length===2);if(innerWidth<1024&&scenario!=='home-user'){document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await until(()=>document.querySelector('[aria-label="Open navigation"]').getAttribute('aria-expanded')==='false');}if(query.has('visual')){if(innerWidth<600){await until(()=>document.querySelector('[aria-label="Prompt options"]'));document.querySelector('[aria-label="Prompt options"]').click();await until(()=>document.querySelector('.composer-options-popup'));if(!document.querySelector('[aria-label="Model"]'))throw Error('Missing Home compact model choice');document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await until(()=>document.querySelector('[aria-label="Prompt options"]').getAttribute('aria-expanded')==='false');}if(scenario==='home-choices'){document.querySelector('[aria-label="Prompt options"]').click();await until(()=>document.querySelector('[aria-label="Plan mode"]'));}await report({ok:true});return;}
            await fetch('/scenario?error');await client.invalidateQueries({queryKey:['projects']});await until(()=>document.querySelector('.home-page [role=alert]'));if(document.querySelector('.home-page').textContent.includes('A place for your next idea'))throw Error('Project failure shown as empty');await fetch('/scenario');await client.invalidateQueries({queryKey:['projects']});await until(()=>document.querySelectorAll('.home-project-row').length===2);
            const textarea=document.querySelector('textarea');document.querySelector('.home-examples button').click();await until(()=>textarea.value.includes('coffee'));
            if(document.activeElement!==textarea)throw Error('Example did not focus editable draft');
            const options=document.querySelector('[aria-label="Prompt options"]');options.focus();options.click();await until(()=>options.getAttribute('aria-expanded')==='true','options open');document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await until(()=>options.getAttribute('aria-expanded')==='false','options Escape closes popup');await until(()=>document.activeElement===options,'options focus restored');options.click();await until(()=>options.getAttribute('aria-expanded')==='true');const mode=document.querySelector('[aria-label="Plan mode"]');mode.click();await until(()=>mode.getAttribute('aria-checked')==='true');
            document.querySelector('.composer-menu-action').click();await until(()=>document.querySelector('[data-slot=dialog-content] input[type=checkbox]'),'initial Skills dialog');if(Number(getComputedStyle(document.querySelector('[data-slot=dialog-content]')).zIndex)<=Number(getComputedStyle(document.querySelector('.composer-options-positioner')).zIndex))throw Error('Skills dialog is behind composer');document.querySelector('[data-slot=dialog-content] input[type=checkbox]').click();await until(()=>document.querySelector('[data-slot=dialog-content]').textContent.includes('1 / 4 selected'),'initial Skills selection');Array.from(document.querySelectorAll('[data-slot=dialog-content] button')).find(node=>node.textContent==='Done').click();await until(()=>!document.querySelector('[data-slot=dialog-content]'),'initial Skills close');if(options.getAttribute('aria-expanded')==='true')options.click();
            await until(()=>!document.querySelector('[aria-label="Send prompt"]').disabled);
            if(window.fixtureRoute||sessionStorage.getItem('wrenly:pending:fixture-created'))throw Error('Example submitted before send');
            document.querySelector('[aria-label="Send prompt"]').click();await until(()=>document.querySelector('.home-page [role=alert]'));
            if(!textarea.value.includes('coffee')||mode.getAttribute('aria-checked')!=='true')throw Error('Failure discarded draft or mode');
            document.querySelector('[aria-label="Send prompt"]').click();await until(()=>window.fixtureRoute);
            const pending=JSON.parse(sessionStorage.getItem('wrenly:pending:fixture-created'));
            if(window.fixtureRoute!=='/p/fixture-created'||pending.mode!=='plan'||pending.model!=='fixture-model'||pending.provider!=='fixture'||!pending.idempotencyKey||!pending.message.includes('coffee'))throw Error('Incomplete conversation handoff');
            await report({ok:true});return;
          }
          if(scenario.startsWith('onboarding')){
            if(scenario==='onboarding-error'){await until(()=>document.querySelector('[role=alert]'));if(document.querySelector('.setup-count'))throw Error('Failure shown as incomplete setup');await fetch('/scenario?summary-ready');Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='Try again').click();}
            await until(()=>document.querySelector('.setup-count'));await document.fonts.ready;
            if(document.documentElement.scrollWidth>innerWidth)throw Error('Onboarding overflows viewport');
            const links=Array.from(document.querySelectorAll('.setup-page a'));
            if(scenario.includes('user')){if(document.querySelector('.app-instance-members'))throw Error('Ordinary user saw owner directory');if(links.some(link=>link.href.includes('/settings/providers')||link.href.includes('/settings/access')))throw Error('Ordinary user saw administrative action');if(!document.body.textContent.includes('Ask your instance owner'))throw Error('Missing member guidance');}
            else if(!links.some(link=>link.href.includes('/settings/providers')))throw Error('Missing owner configuration action');
            if(!document.body.textContent.includes('not been tested'))throw Error('Configuration presented as verified health');await report({ok:true});return;
          }
          await until(()=>document.querySelector('.app-project-row'));await document.fonts.ready;
          if(document.documentElement.scrollWidth>innerWidth)throw Error('Navigation overflows viewport');if(document.querySelector('a a,button a,a button'))throw Error('Nested interactive navigation');
          if(query.has('visual')){if(innerWidth<1024){document.querySelector('[aria-label="Open navigation"]').click();await until(()=>document.querySelector('[role=dialog]'));}await report({ok:true});return;}
          if(scenario==='mobile'){
            const trigger=document.querySelector('[aria-label="Open navigation"]');trigger.focus();trigger.click();await until(()=>document.querySelector('[role=dialog]'));const dialog=document.querySelector('[role=dialog]');await until(()=>document.activeElement===dialog.querySelector('input'),'initial focus');
            const guards=document.querySelectorAll('[data-base-ui-focus-guard][data-type=inside]');if(guards.length<2)throw Error('Missing modal focus guards');guards[guards.length-1].focus();await until(()=>dialog.contains(document.activeElement),'forward focus containment');guards[0].focus();await until(()=>dialog.contains(document.activeElement),'backward focus containment');document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await until(()=>!document.querySelector('[role=dialog]'),'initial Skills close');await until(()=>document.activeElement===trigger,'focus restoration');
            document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));await until(()=>document.querySelector('[role=dialog]'));await until(()=>document.activeElement.tagName==='INPUT');document.querySelector('[role=dialog] a').focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));await until(()=>document.activeElement.tagName==='INPUT','shortcut within open drawer');fill(document.activeElement,'Studio');await until(()=>document.querySelector('[role=dialog]').querySelectorAll('.app-project-row').length===1);
            await report({ok:true});return;
          }
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));await until(()=>document.activeElement===document.querySelector('.app-desktop-search input'));fill(document.activeElement,'Studio');await until(()=>document.querySelectorAll('.app-project-row').length===1);fill(document.activeElement,'');await until(()=>document.querySelectorAll('.app-project-row').length===2);
          Array.from(document.querySelectorAll('.app-project-filters button')).find(node=>node.textContent==='Failed').click();await until(()=>document.querySelectorAll('.app-project-row').length===1);if(!document.querySelector('.app-project-row').textContent.includes('Field notes'))throw Error('Incorrect filter');document.querySelector('.app-project-filters button').click();
          await fetch('/scenario?error');await client.invalidateQueries({queryKey:['projects']});await until(()=>document.querySelector('[role=alert]'));if(document.body.textContent.includes('Your first project starts here'))throw Error('Query failure shown as empty');await fetch('/scenario');Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='Try again').click();await until(()=>document.querySelectorAll('.app-project-row').length===2);
          await fetch('/scenario?session');await client.invalidateQueries({queryKey:['projects']});await until(()=>Array.from(document.querySelectorAll('a')).some(node=>node.textContent==='Sign in again'),'expired session action');await fetch('/scenario');await client.invalidateQueries({queryKey:['projects']});await until(()=>document.querySelectorAll('.app-project-row').length===2);
          await until(()=>document.querySelector('[aria-label="Account menu for James"]'));document.querySelector('[aria-label="Account menu for James"]').click();await until(()=>document.querySelector('[role=menuitem]'));if(!document.querySelector('[aria-label="Appearance"]'))throw Error('Missing account appearance controls');document.querySelector('[aria-label="Dark theme"]').click();if(document.documentElement.getAttribute('data-theme')!=='dark')throw Error('Theme choice did not apply');Array.from(document.querySelectorAll('[role=menuitem]')).find(node=>node.textContent==='Sign out').click();await until(()=>document.querySelector('.app-account-error'));if(!client.getQueryData(['projects']))throw Error('Failed sign-out cleared private cache');document.querySelector('[aria-label="Account menu for James"]').click();await until(()=>document.querySelector('[role=menuitem]'));Array.from(document.querySelectorAll('[role=menuitem]')).find(node=>node.textContent==='Sign out').click();
        }catch(error){await report({error:error.message})}})();`,
      );
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
          'process.env.NODE_ENV="production"',
          "--define",
          "process.env.NEXT_PUBLIC_DOCS_URL=undefined",
          "--define",
          "process.env.NEXT_PUBLIC_WEB_URL=" +
            JSON.stringify(server.url.origin),
        ],
        { cwd: web, stdout: "pipe", stderr: "pipe" },
      );
      const [code, diagnostic] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ]);
      if (code !== 0) throw new Error(diagnostic);
      bundle = await readFile(output, "utf8");
      for (const scenario of [
        { id: "desktop", width: 1440, visual: false },
        { id: "mobile", width: 390, visual: false },
        { id: "navigation-desktop", width: 1440, visual: true },
        { id: "navigation-mobile", width: 390, visual: true },
        { id: "onboarding-owner", width: 1440, visual: true },
        { id: "onboarding-user", width: 390, visual: true },
        { id: "onboarding-error", width: 1440, visual: false },
        { id: "projects", width: 1440, visual: false },
        { id: "projects-desktop", width: 1440, visual: true },
        { id: "projects-mobile", width: 390, visual: true },
        { id: "projects-small", width: 320, visual: true },
        { id: "projects-tablet", width: 768, visual: true },
        { id: "projects-dark", width: 1440, visual: true },
        { id: "home", width: 1440, visual: false },
        { id: "home-many", width: 1440, visual: true },
        { id: "home-complete", width: 1440, visual: true },
        { id: "home-user", width: 390, visual: true },
        { id: "home-desktop", width: 1440, visual: true },
        { id: "home-mobile", width: 390, visual: true },
        { id: "home-small", width: 320, visual: true },
        { id: "home-dark", width: 1440, visual: true },
        { id: "home-choices", width: 1440, visual: true },
        { id: "home-members-error", width: 1440, visual: true },
      ]) {
        homeMany = scenario.id === "home-many";
        setupComplete = scenario.id === "home-complete";
        collection = scenario.id.startsWith("projects");
        onboarding = scenario.id.startsWith("onboarding");
        summaryRole = scenario.id.includes("user") ? "user" : "owner";
        summaryFailure = scenario.id === "onboarding-error";
        memberFailure = scenario.id === "home-members-error";
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
                  "--virtual-time-budget=3000",
                  `--screenshot=${join(captures, scenario.id + ".png")}`,
                ]
              : []),
            `${server.url.origin}${onboarding ? "/get-started" : collection ? "/projects" : "/"}?case=${scenario.id}${scenario.visual ? "&visual" : ""}${scenario.id.includes("dark") ? "&dark" : ""}`,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        const deadline = Date.now() + 18_000;
        while (!reports.has(scenario.id) && Date.now() < deadline)
          await Bun.sleep(20);
        expect(reports.get(scenario.id)?.error).toBeUndefined();
        expect(reports.get(scenario.id)?.ok).toBe(true);
        if (!scenario.visual) chrome.kill();
        await chrome.exited;
        chrome = undefined;
      }
      expect(signOuts).toBe(2);
      expect(projectCreates).toBe(2);
      expect(createBodies.map(body => body.skillVersionIds)).toEqual([[initialVersionId], [initialVersionId]]);
      expect(unauthorizedMemberReads).toBe(0);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
