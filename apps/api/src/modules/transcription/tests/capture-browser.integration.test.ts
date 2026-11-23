/** Real Chrome audio processing with a browser-provided fake microphone; no audio leaves the fixture page. */
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const browserTest =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true" ? test : test.skip;
browserTest(
  "worklet capture returns canonical audio and closes stopped, cancelled and late-granted tracks",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-dictation-browser-"),
    );
    const web = resolve(import.meta.dir, "../../../../../web");
    let result: { ok?: boolean; error?: string; seconds?: number } | undefined;
    let bundle = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript" },
          });
        if (path === "/report") {
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        return new Response('<script src="/bundle.js"></script>', {
          headers: { "content-type": "text/html" },
        });
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "capture.ts");
      await writeFile(
        entry,
        `import {createMicrophoneCapture} from '${web}/components/workspace/dictation/microphone-capture';
import {validateDictationWav} from '${web}/node_modules/@wrenly/audio';
(async()=>{try{
const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);const streams=[];
navigator.mediaDevices.getUserMedia=async c=>{const stream=await original(c);streams.push(stream);return stream};
const capture=createMicrophoneCapture();await capture.start(()=>{});await new Promise(r=>setTimeout(r,600));
const audio=await capture.stop();if(!audio)throw Error('No captured samples');const info=validateDictationWav(audio);
if(info.durationSeconds<0.1||info.durationSeconds>2)throw Error('Invalid captured duration');
if(streams.some(s=>s.getTracks().some(t=>t.readyState!=='ended')))throw Error('Stopped track still active');
await capture.start(()=>{});await capture.cancel();if(await capture.stop()!==null)throw Error('Cancelled samples retained');
if(streams.some(s=>s.getTracks().some(t=>t.readyState!=='ended')))throw Error('Cancelled track still active');
const late=await original({audio:true});let grant;navigator.mediaDevices.getUserMedia=()=>new Promise(r=>{grant=r});
const pending=capture.start(()=>{});await capture.cancel();grant(late);await pending;
if(late.getTracks().some(t=>t.readyState!=='ended'))throw Error('Late permission revived recording');
await fetch('/report',{method:'POST',body:JSON.stringify({ok:true,seconds:info.durationSeconds})});
}catch(e){await fetch('/report',{method:'POST',body:JSON.stringify({error:String(e)})});}})();`,
      );
      const build = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          entry,
          "--target=browser",
          "--outdir",
          join(directory, "out"),
        ],
        { cwd: web, stdout: "ignore", stderr: "pipe" },
      );
      const diagnostics = await new Response(build.stderr).text();
      if (await build.exited) throw Error(diagnostics);
      bundle = await readFile(join(directory, "out/capture.js"), "utf8");
      chrome = Bun.spawn(
        [
          "/usr/bin/google-chrome",
          "--headless=new",
          "--disable-gpu",
          "--disable-background-networking",
          "--no-first-run",
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
          "--autoplay-policy=no-user-gesture-required",
          `--user-data-dir=${join(directory, "profile")}`,
          server.url.origin,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const end = Date.now() + 20000;
      while (!result && Date.now() < end) await Bun.sleep(20);
      expect(result?.error).toBeUndefined();
      expect(result?.ok).toBe(true);
      expect(result?.seconds).toBeGreaterThan(0.1);
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
