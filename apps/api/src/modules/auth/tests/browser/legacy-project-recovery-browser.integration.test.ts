// Real recovery page, controlled HTTP: verifies selection never mutates before explicit confirmation.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true"
    ? describe
    : describe.skip;
integration("Chrome legacy project recovery", () => {
  test("shows blockers, reviews exact selection and retries confirmation with one request identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-legacy-browser-"));
    const web = resolve(import.meta.dir, "../../../../../../web");
    const projectId = crypto.randomUUID(),
      reviewId = crypto.randomUUID();
    const confirmations: Array<{ reviewId: string; requestId: string }> = [];
    let bundle = "",
      blocked = true,
      transferred = false;
    let result: { ok?: boolean; error?: string } | undefined;
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
        if (path === "/unblock") {
          blocked = false;
          return new Response("ok");
        }
        if (path === "/api/auth/get-session")
          return Response.json({
            user: { id: "owner", email: "owner@example.test" },
          });
        if (path === "/api/instance/legacy-projects")
          return Response.json({
            projects: transferred
              ? []
              : [{ id: projectId, name: "Preserved legacy app" }],
            more: false,
          });
        if (path === "/api/instance/legacy-projects/review") {
          const input: unknown = await request.json();
          if (
            !input ||
            typeof input !== "object" ||
            !("projectIds" in input) ||
            JSON.stringify(input.projectIds) !== JSON.stringify([projectId])
          )
            return Response.json(
              { error: "Selection mismatch" },
              { status: 400 },
            );
          return Response.json({
            reviewId: blocked ? null : reviewId,
            projects: [{ id: projectId, name: "Preserved legacy app" }],
            blockers: blocked
              ? ["Stop previews and wait for verified container cleanup."]
              : [],
          });
        }
        if (path === "/api/instance/legacy-projects/confirm") {
          confirmations.push(
            (await request.json()) as { reviewId: string; requestId: string },
          );
          transferred = true;
          return confirmations.length === 1
            ? Response.json(
                { error: "Acknowledgement lost. Retry confirmation." },
                { status: 503 },
              )
            : Response.json({ transferred: 1, replayed: true });
        }
        return new Response(
          '<div id="root"></div><script src="/bundle.js"></script>',
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const fixture = `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};
        import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};
        import Page from ${JSON.stringify(join(web, "app/(app)/settings/legacy-projects/page.tsx"))};
        createRoot(document.getElementById('root')).render(React.createElement(Page));
        const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const until=async check=>{for(let n=0;n<500;n++){if(check())return;await sleep(10)}throw Error('Recovery browser timed out')};
        const button=text=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent.includes(text));
        (async()=>{try{
          await until(()=>document.querySelector('input[type=checkbox]'));
          if(button('Confirm recovery'))throw Error('Confirmation visible before review');
          document.querySelector('input[type=checkbox]').click();await until(()=>button('Review 1 selected')&&!button('Review 1 selected').disabled);button('Review 1 selected').click();
          await until(()=>document.body.textContent.includes('verified container cleanup'));
          if(button('Confirm recovery'))throw Error('Blocked review allowed confirmation');
          await fetch('/unblock');button('Change selection').click();await until(()=>button('Review 1 selected')&&!button('Review 1 selected').disabled);button('Review 1 selected').click();
          await until(()=>button('Confirm recovery'));
          if(!document.body.textContent.includes('owner@example.test'))throw Error('Missing destination account');
          button('Confirm recovery').click();await until(()=>document.body.textContent.includes('Acknowledgement lost'));
          await until(()=>!button('Confirm recovery').disabled);button('Confirm recovery').click();
          await until(()=>document.body.textContent.includes('1 project recovered'));
          await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});
        }catch(error){await fetch('/report',{method:'POST',body:JSON.stringify({error:error.message})})}})();`;
      const entry = join(directory, "fixture.ts");
      await writeFile(entry, fixture);
      const built = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        minify: true,
        define: {
          "process.env.NODE_ENV": '"production"',
          "process.env.NEXT_PUBLIC_DOCS_URL": "undefined",
        },
        plugins: [
          {
            name: "legacy-browser-fixture",
            setup(build) {
              build.onResolve({ filter: /^@\// }, (args) => ({
                path: Bun.resolveSync(resolve(web, args.path.slice(2)), web),
              }));
              build.onResolve({ filter: /^[^./]/ }, (args) => {
                try {
                  return {
                    path: Bun.resolveSync(args.path, dirname(args.importer)),
                  };
                } catch {
                  return { path: Bun.resolveSync(args.path, web) };
                }
              });
            },
          },
        ],
      });
      if (!built.success || !built.outputs[0])
        throw new Error(
          `Recovery browser bundle failed: ${built.logs.map((log) => log.message).join("; ")}`,
        );
      bundle = await built.outputs[0].text();
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
          `${server.url.origin}/settings/legacy-projects`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 15_000;
      while (!result && Date.now() < deadline) await Bun.sleep(20);
      expect(result?.error).toBeUndefined();
      expect(result?.ok).toBe(true);
      expect(confirmations).toHaveLength(2);
      expect(confirmations[0]?.reviewId).toBe(reviewId);
      expect(confirmations[0]?.requestId).toBe(confirmations[1]?.requestId);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
