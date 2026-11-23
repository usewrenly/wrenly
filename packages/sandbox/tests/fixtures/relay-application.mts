/** Disposable networking acceptance only; never part of a generated app image. */
import { startApplicationHttpBridge } from "../../src/deployment-runtime/application-http.js";
const controller = new AbortController();
await startApplicationHttpBridge(controller.signal);
Bun.serve({
  hostname: "127.0.0.1",
  port: 3000,
  fetch: () => new Response("isolated-application"),
});
