/** Real Chrome audio processing with a browser-provided fake microphone; no audio leaves the fixture page. */
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const browserTest =
  process.env.WRENLY_TEST_INSTANCE_BROWSER === "true" ? test : test.skip;
browserTest(
  "dictation inserts directly into the live draft, supports undo, never auto-sends, and falls back to review when full",
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
        if (path === "/api/transcription") {
          if (request.method === "GET")
            return Response.json({ available: true });
          await request.arrayBuffer();
          await Bun.sleep(400);
          return Response.json({ text: "Recognized fixture words." });
        }
        if (path === "/report") {
          result = (await request.json()) as typeof result;
          return new Response("ok");
        }
        return new Response(
          '<div id="root"></div><script src="/bundle.js"></script>',
          {
            headers: { "content-type": "text/html" },
          },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "capture.tsx");
      await writeFile(
        entry,
        `import React,{useRef,useState} from '${web}/node_modules/react';
import {createRoot} from '${web}/node_modules/react-dom/client';
import {useDictation} from '${web}/components/workspace/dictation/use-dictation';
import {DictationPanel} from '${web}/components/workspace/dictation/dictation-panel';
import {insertTranscriptText} from '${web}/components/workspace/dictation/insert-transcript';
function App(){
  const [prompt,setPrompt]=useState('Original draft');
  const [full,setFull]=useState(false);
  const [sent,setSent]=useState(0);
  const prevRef=useRef(null);
  const voice=useDictation(
    false,
    text=>{
      if(full)return false;
      const next=insertTranscriptText(prompt,text);
      if(!next)return false;
      prevRef.current=prompt;
      setPrompt(next.text);
      return true;
    },
    ()=>{if(prevRef.current!==null){setPrompt(prevRef.current);prevRef.current=null;}}
  );
  return <>
    <button disabled={!voice.available} onClick={voice.begin}>Microphone</button>
    <button onClick={()=>setPrompt('Typed while waiting')}>Change draft</button>
    <button onClick={()=>setFull(v=>!v)}>{full?'Unlock':'Fill'}</button>
    <textarea aria-label="Prompt" value={prompt} onChange={e=>setPrompt(e.target.value)}/>
    <button onClick={()=>setSent(sent+1)}>Send</button>
    <output>{sent}</output>
    <DictationPanel dictation={voice} disabled={false}/>
  </>;
}
createRoot(document.getElementById('root')).render(<App/>);
const wait=async(fn)=>{const end=Date.now()+10000;while(!fn()){if(Date.now()>end)throw Error('Browser condition timed out: '+document.body.textContent);await new Promise(r=>setTimeout(r,20))}};
const button=name=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===name);
(async()=>{try{
  await wait(()=>button('Microphone')&&!button('Microphone').disabled);
  button('Microphone').click();
  await wait(()=>button('Start recording'));button('Start recording').click();
  await wait(()=>button('Stop and transcribe'));
  await new Promise(r=>setTimeout(r,350));
  button('Stop and transcribe').click();
  button('Change draft').click();
  await wait(()=>button('Undo'));
  if(document.querySelector('[aria-label=Prompt]').value!=='Typed while waiting\\nRecognized fixture words.')throw Error('Direct insertion lost current draft: '+document.querySelector('[aria-label=Prompt]').value);
  if(document.querySelector('output').textContent!=='0')throw Error('Dictation submitted a prompt');
  button('Undo').click();
  await wait(()=>!button('Undo'));
  if(document.querySelector('[aria-label=Prompt]').value!=='Typed while waiting')throw Error('Undo did not restore pre-dictation draft');
  button('Fill').click();
  button('Microphone').click();
  await wait(()=>button('Stop and transcribe'));
  await new Promise(r=>setTimeout(r,350));
  button('Stop and transcribe').click();
  await wait(()=>button('Insert into prompt'));
  button('Unlock').click();
  await wait(()=>button('Fill'));
  button('Insert into prompt').click();
  await wait(()=>!button('Insert into prompt')&&button('Undo'));
  if(document.querySelector('[aria-label=Prompt]').value!=='Typed while waiting\\nRecognized fixture words.')throw Error('Fallback insert failed');
  document.querySelector('[aria-label="Cancel dictation"]').click();
  await wait(()=>!document.querySelector('[aria-label="Voice dictation"]'));
  await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})});
}catch(e){await fetch('/report',{method:'POST',body:JSON.stringify({error:String(e)})})}})();
`,
      );
      const config = join(directory, "tsconfig.json");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            baseUrl: web,
            paths: { "@/*": ["./*"], "react/*": ["./node_modules/react/*"] },
          },
        }),
      );
      const build = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          entry,
          "--target=browser",
          "--tsconfig-override",
          config,
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
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
