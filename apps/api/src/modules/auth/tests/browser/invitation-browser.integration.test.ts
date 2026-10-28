// Real owner/recipient pages with controlled services; no operator accounts or email delivery.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome instance invitations", () => {
  test("owner issues a private link, recipient clears proof on failure and retries before ordinary sign-in", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-invitation-browser-"),
    );
    const web = resolve(import.meta.dir, "../../../../../../web");
    const id = crypto.randomUUID(),
      proof = "p".repeat(43);
    let bundle = "",
      recipient = false,
      inspectionCalls = 0,
      issued = false;
    let result: { ok?: boolean; error?: string } | undefined;
    const acceptances: Array<{ id: string; proof: string; requestId: string }> =
      [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/bundle.js")
          return new Response(bundle, {
            headers: {
              "Content-Type": "application/javascript; charset=utf-8",
            },
          });
        if (path === "/report") {
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        if (path === "/recipient") {
          recipient = true;
          return new Response("ok");
        }
        if (path === "/api/instance/access/members")
          return Response.json({
            members: [
              {
                id: "owner",
                email: "owner@example.test",
                name: "Owner",
                role: "owner",
              },
            ],
            invitations: issued
              ? [
                  {
                    id,
                    email: "invited@example.test",
                    status: "pending",
                    expiresAt: new Date(Date.now() + 60000).toISOString(),
                  },
                ]
              : [],
          });
        if (path === "/api/instance/invitations") {
          const value: unknown = await request.json();
          if (
            !value ||
            typeof value !== "object" ||
            !("email" in value) ||
            value.email !== "invited@example.test"
          )
            return Response.json({ error: "Email mismatch" }, { status: 400 });
          issued = true;
          return Response.json({
            id,
            link: `${server.url.origin}/accept-invitation#invitation=${id}&proof=${proof}`,
          });
        }
        if (path === "/api/auth/get-session")
          return Response.json(
            recipient
              ? null
              : { user: { id: "owner", email: "owner@example.test" } },
          );
        if (path === "/api/instance/invitations/inspect") {
          inspectionCalls++;
          if (inspectionCalls === 1)
            return Response.json(
              { error: "Invitation check unavailable." },
              { status: 503 },
            );
          return Response.json({
            email: "invited@example.test",
            existingAccount: false,
            accepted: false,
          });
        }
        if (path === "/api/instance/invitations/accept") {
          acceptances.push(
            (await request.json()) as {
              id: string;
              proof: string;
              requestId: string;
            },
          );
          if (acceptances.length === 1)
            return Response.json(
              { error: "Acknowledgement lost. Retry acceptance." },
              { status: 503 },
            );
          return Response.json({
            email: "invited@example.test",
            accountCreated: true,
            replayed: true,
          });
        }
        if (path === "/api/auth/sign-in/email")
          return Response.json(
            { success: true },
            {
              headers: {
                "Set-Cookie":
                  "fixture-invited=confirmed; HttpOnly; Path=/; SameSite=Lax",
              },
            },
          );
        if (path === "/")
          return new Response(
            `<script>fetch('/report',{method:'POST',body:JSON.stringify(${request.headers.get("cookie")?.includes("fixture-invited=confirmed") ? "{ok:true}" : "{error:'Workspace entered without sign-in'}"})})</script>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        return new Response(
          '<div id="root"></div><script type="module" src="/bundle.js"></script>',
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const fixture = `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};
        import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};
        import {QueryClient,QueryClientProvider} from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};
        import Access from ${JSON.stringify(join(web, "app/(app)/settings/access/page.tsx"))};
        import Accept from ${JSON.stringify(join(web, "app/(auth)/accept-invitation/page.tsx"))};
        window.addEventListener('error',event=>{void fetch('/report',{method:'POST',body:JSON.stringify({error:event.error?.stack??event.message})})});
        const recipient=location.pathname==='/accept-invitation';createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(recipient?Accept:Access)));
        const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        let waitStep=0;const until=async check=>{const step=++waitStep;for(let n=0;n<500;n++){if(check())return;await sleep(10)}throw Error('Invitation browser timed out at step '+step+' on '+location.pathname+': '+document.body.textContent.slice(0,600))};
        (async()=>{try{if(!recipient){
          await until(()=>document.querySelector('input[type=email]'));
          const email=document.querySelector('input[type=email]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(email,'invited@example.test');email.dispatchEvent(new Event('input',{bubbles:true}));
          await until(()=>!document.querySelector('button[type=submit]').disabled);document.querySelector('form').requestSubmit();
          await until(()=>document.querySelector('[aria-label="Private invitation link"]'));
          const link=document.querySelector('[aria-label="Private invitation link"]').value;
          if(!link.includes('#invitation='))throw Error('Private link lacks fragment');
          if(localStorage.length||sessionStorage.length)throw Error('Private link persisted in browser storage');
          await fetch('/recipient');location.href=link;
        }else{
          await until(()=>document.querySelector('[role=alert]'));
          if(location.hash)throw Error('Proof remained in address bar on failure');
          Array.from(document.querySelectorAll('button')).find(node=>node.textContent==='Try again').click();
          await until(()=>document.querySelector('input[name=password]'));
          document.querySelector('input[name=name]').value='Invited';document.querySelector('input[name=password]').value='invited-password-12345';document.querySelector('form').requestSubmit();
          await until(()=>document.body.textContent.includes('Acknowledgement lost'));
          await until(()=>!document.querySelector('button[type=submit]').disabled);document.querySelector('form').requestSubmit();
        }}catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})})}})();`;
      const entry = join(directory, "fixture.ts");
      await writeFile(entry, fixture);
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
          "--define",
          "process.env.NEXT_PUBLIC_WEB_URL=" +
            JSON.stringify(server.url.origin),
          "--tsconfig-override",
          config,
          "--outfile",
          output,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const diagnostic = await new Response(built.stderr).text();
      if (await built.exited) throw new Error(diagnostic);
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
          `${server.url.origin}/settings/access`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 20_000;
      while (!result && Date.now() < deadline) await Bun.sleep(20);
      expect(result?.error).toBeUndefined();
      expect(result?.ok).toBe(true);
      expect(acceptances).toHaveLength(2);
      expect(acceptances[0]?.proof).toBe(proof);
      expect(acceptances[0]?.requestId).toBe(acceptances[1]?.requestId);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
