// Actual Chrome cookie/iframe probe; controlled app only, no inference or deployment.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createPreviewGateway, PREVIEW_COOKIE } from "../../gateway/preview-gateway";
import { createPreviewIngressHandler } from "../../gateway/preview-ingress";

const integration =
  process.env.WRENLY_TEST_PREVIEW_BROWSER === "true" ? describe : describe.skip;
integration("Chrome preview boundary", () => {
  test("fragment bootstrap, host-only cookies, frame isolation and revocation", async () => {
    const id = crypto.randomUUID();
    const grant = "a".repeat(64);
    const session = "b".repeat(64);
    const capability = "c".repeat(64);
    const profile = await mkdtemp(join(tmpdir(), "wrenly-preview-chrome-"));
    let consumed = false;
    let ready = true;
    let report: Record<string, unknown> | undefined;
    let revokedReport: number | undefined;
    let leaked = false;
    let escaped = false;
    let mediaRequests = 0;
    let blockedMediaRequests = 0;
    const allowMedia = process.env.WRENLY_TEST_PREVIEW_MEDIA_BROWSER === "true";
    let receivedCookies = "";
    let receivedCapability = false;
    let controlOrigin = "";
    let previewOrigin = "";
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        receivedCookies = request.headers.get("cookie") ?? "";
        receivedCapability = request.headers.has("x-wrenly-preview-ingress");
        if (new URL(request.url).pathname === "/_next/static/css/fixture.css")
          return new Response(".p-8{padding:32px}.text-3xl{font-size:30px}", {
            headers: { "content-type": "text/css" },
          });
        return new Response(
          `<!doctype html><link rel="stylesheet" href="/_next/static/css/fixture.css"><main id="styled" class="p-8 text-3xl">Styled fixture</main><script>
        document.cookie='app_session=app;Path=/';document.cookie='control_secret=poison;Domain=localhost;Path=/';
        let isolated=false;try{parent.document.body}catch{isolated=true}
        let navigationBlocked=false;try{top.location=${JSON.stringify("http://localhost:PLACEHOLDER/escaped")}}catch{navigationBlocked=true}
        fetch(${JSON.stringify("http://localhost:PLACEHOLDER/leak")}).then(()=>{}).catch(()=>{});
        const style=getComputedStyle(document.getElementById('styled'));
        const media=new Image();const loaded=new Promise(resolve=>{media.onload=()=>resolve(true);media.onerror=()=>resolve(false)});media.src=${JSON.stringify("http://localhost:PLACEHOLDER/media.svg")};
        const blocked=new Image();blocked.src=${JSON.stringify("http://127.0.0.1:BLOCKEDPORT/blocked-media.svg")};
        loaded.then(mediaLoaded=>parent.postMessage({mediaLoaded,isolated,navigationBlocked,padding:style.paddingTop,fontSize:style.fontSize,cookie:document.cookie,hash:location.hash,referrer:document.referrer},${JSON.stringify("http://localhost:PLACEHOLDER")}));
        addEventListener('message',async event=>{if(event.origin!==${JSON.stringify("http://localhost:PLACEHOLDER")})return;const r=await fetch('/revoked');parent.postMessage({revoked:r.status},event.origin)});
      </script>`
            .replaceAll("http://localhost:PLACEHOLDER", controlOrigin)
            .replaceAll(
              "http://127.0.0.1:BLOCKEDPORT",
              controlOrigin.replace("localhost", "127.0.0.1"),
            ),
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    let ingressHandler: ReturnType<typeof createPreviewIngressHandler>;
    const ingress = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => ingressHandler(request),
    });
    let gatewayHandler: ReturnType<typeof createPreviewGateway>;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/media.svg") {
          mediaRequests++;
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
            { headers: { "content-type": "image/svg+xml" } },
          );
        }
        if (url.pathname === "/blocked-media.svg") {
          blockedMediaRequests++;
          return new Response("blocked");
        }
        if (url.hostname !== "localhost") {
          const response = await gatewayHandler(request);
          // Exercise browser CSP against a controlled local asset server, never the real CDN.
          if (allowMedia && response.headers.has("content-security-policy"))
            response.headers.set(
              "content-security-policy",
              response.headers
                .get("content-security-policy")!
                .replaceAll("https://images.unsplash.com", controlOrigin),
            );
          return response;
        }
        if (url.pathname === "/report") {
          report = (await request.json()) as Record<string, unknown>;
          ready = false;
          return new Response("ok");
        }
        if (url.pathname === "/revoked-report") {
          revokedReport = Number(await request.text());
          return new Response("ok");
        }
        if (url.pathname === "/leak") {
          leaked = true;
          return new Response("leak");
        }
        if (url.pathname === "/escaped") {
          escaped = true;
          return new Response("escape");
        }
        return new Response(
          `<!doctype html><script>document.cookie='control_secret=original;Path=/';addEventListener('message',async e=>{if(e.origin!==${JSON.stringify(previewOrigin)})return;if('revoked'in e.data){await fetch('/revoked-report',{method:'POST',body:String(e.data.revoked)});return}await fetch('/report',{method:'POST',body:JSON.stringify({...e.data,controlCookie:document.cookie})});document.querySelector('iframe').contentWindow.postMessage('revoke',e.origin)});</script><iframe sandbox="allow-scripts allow-forms allow-same-origin" src="${previewOrigin}/__wrenly/bootstrap#${grant}"></iframe>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    controlOrigin = `http://localhost:${server.port}`;
    previewOrigin = `http://${id}.wrenly-preview.localhost:${server.port}`;
    ingressHandler = createPreviewIngressHandler({
      upstream: "http://172.30.0.2:3000",
      previewOrigin,
      controlOrigin,
      capability,
      blockedCookieNames: [PREVIEW_COOKIE, "control_secret"],
      fetch: (request) =>
        fetch(`http://127.0.0.1:${app.port}${new URL(request.url).pathname}`, {
          headers: request.headers,
        }),
    });
    gatewayHandler = createPreviewGateway({
      baseUrl: `http://wrenly-preview.localhost:${server.port}`,
      controlOrigin,
      mediaOrigins: async () =>
        allowMedia ? ["https://images.unsplash.com"] : [],
      consume: async (_id, value) => {
        if (consumed || value !== grant) return null;
        consumed = true;
        return session;
      },
      authorize: async (_id, value) =>
        ready && value === session ? "owner" : null,
      touch: async () => ready,
      runtime: () => ({
        ingressUrl: `http://127.0.0.1:${ingress.port}`,
        capability,
      }),
    });
    const chrome = Bun.spawn(
      [
        process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
        "--headless=new",
        "--incognito",
        "--disable-gpu",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        controlOrigin,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      const deadline = Date.now() + 20_000;
      while (revokedReport === undefined && Date.now() < deadline)
        await Bun.sleep(20);
      expect(consumed).toBe(true);
      expect(report?.mediaLoaded).toBe(allowMedia);
      expect(mediaRequests).toBe(allowMedia ? 1 : 0);
      expect(blockedMediaRequests).toBe(0);
      expect(report?.isolated).toBe(true);
      expect(report?.navigationBlocked).toBe(true);
      expect(report?.padding).toBe("32px");
      expect(report?.fontSize).toBe("30px");
      expect(report?.hash).toBe("");
      expect(report?.referrer).toBe("");
      expect(report?.cookie).not.toContain(PREVIEW_COOKIE);
      expect(report?.controlCookie).toContain("control_secret=original");
      expect(receivedCookies).not.toContain("control_secret");
      expect(receivedCookies).not.toContain(PREVIEW_COOKIE);
      expect(receivedCapability).toBe(false);
      expect(leaked).toBe(false);
      expect(escaped).toBe(false);
      expect(revokedReport).toBe(401);
    } finally {
      chrome.kill();
      await chrome.exited;
      await server.stop(true);
      await ingress.stop(true);
      await app.stop(true);
      await rm(profile, { recursive: true, force: true });
    }
  }, 30_000);
});
