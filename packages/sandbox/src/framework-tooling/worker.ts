/** Runs only inside a credential-free inspection container; stdout is a bounded machine receipt. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";
import {
  FRAMEWORK_INSPECTION_LIMITS as LIMITS,
  supportsFrameworkInspection,
  frameworkInspectionRequest,
  assertNoArgumentErrorTool,
  applicationInformationReport,
  nextRuntimeFactsReport,
  type InspectionFramework,
} from "@wrenly/inference/framework-tooling";
const CHILD_ENV = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/tmp",
  APP_ENV: "local",
  APP_DEBUG: "false",
  APP_CONFIG_CACHE: "/tmp/config.php",
  APP_SERVICES_CACHE: "/tmp/services.php",
  APP_PACKAGES_CACHE: "/tmp/packages.php",
  LOG_CHANNEL: "stderr",
  DB_CONNECTION: "sqlite",
  DB_DATABASE: ":memory:",
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "development",
};
let development: ReturnType<typeof Bun.spawn> | undefined;
let browser: ReturnType<typeof Bun.spawn> | undefined;
let transport: StdioClientTransport | undefined;
const abort = new AbortController();
const watchdog = setTimeout(() => {
  browser?.kill("SIGKILL");
  development?.kill("SIGKILL");
  process.exit(124);
}, LIMITS.totalMilliseconds);
process.stdin.on("end", () => {
  abort.abort();
  browser?.kill("SIGKILL");
  development?.kill("SIGKILL");
  void transport?.close();
});
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid inspection data");
  return value as Record<string, unknown>;
}
async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Inspection call deadline")),
          LIMITS.callMilliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function input(): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let data = "";
    const receive = (chunk: Buffer): void => {
      data += chunk.toString("utf8");
      if (data.length > 4096) {
        process.stdin.off("data", receive);
        reject(Error("Input too large"));
      } else if (data.includes("\n")) {
        process.stdin.off("data", receive);
        try {
          resolve(record(JSON.parse(data.trim())));
        } catch {
          reject(Error("Invalid input"));
        }
      }
    };
    process.stdin.on("data", receive);
    process.stdin.once("end", () => reject(Error("Controller ended")));
  });
}
function textResult(value: unknown): string {
  const data = record(value);
  if (data.isError === true || !Array.isArray(data.content))
    throw Error("Tool unavailable");
  const text = data.content
    .map((item) => {
      const entry = record(item);
      return entry.type === "text" && typeof entry.text === "string"
        ? entry.text
        : "";
    })
    .join("\n");
  if (Buffer.byteLength(text) > LIMITS.maximumReportBytes)
    throw Error("Tool output too large");
  return text;
}
async function run(): Promise<unknown> {
  const data = await input();
  if (
    Object.keys(data).some(
      (key) => !["framework", "sourceHash", "toolchainHash"].includes(key),
    )
  )
    throw Error("Unknown inspection input");
  if (data.framework !== "laravel" && data.framework !== "nextjs")
    throw Error("Unsupported framework");
  const framework: InspectionFramework = data.framework;
  if (
    typeof data.sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.sourceHash) ||
    typeof data.toolchainHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.toolchainHash)
  )
    throw Error("Invalid source identity");
  const expected = {
    framework,
    sourceHash: data.sourceHash,
    toolchainHash: data.toolchainHash,
  };
  let version: unknown;
  if (framework === "nextjs")
    version = record(
      JSON.parse(await readFile("/app/node_modules/next/package.json", "utf8")),
    ).version;
  else {
    const installed = record(
      JSON.parse(await readFile("/app/vendor/composer/installed.json", "utf8")),
    );
    if (!Array.isArray(installed.packages))
      throw Error("Missing installed packages");
    version = installed.packages
      .map(record)
      .find((pkg) => pkg.name === "laravel/framework")?.version;
    if (typeof version === "string") version = version.replace(/^v/, "");
  }
  if (
    typeof version !== "string" ||
    !supportsFrameworkInspection(framework, version)
  )
    return { status: "unavailable", reason: "unsupported_version" };
  const request = frameworkInspectionRequest(framework, version);
  if (framework === "nextjs") {
    development = Bun.spawn(
      [
        "/usr/local/bin/node",
        "/app/node_modules/next/dist/bin/next",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        "3000",
      ],
      {
        cwd: "/app",
        env: CHILD_ENV,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    let ready = false;
    for (let attempt = 0; attempt < 80 && !abort.signal.aborted; attempt++) {
      try {
        const response = await fetch("http://127.0.0.1:3000/_next/mcp", {
          signal: AbortSignal.timeout(150),
          redirect: "error",
        });
        await response.body?.cancel();
        ready = true;
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    if (!ready)
      return {
        status: "unavailable",
        reason: "development_server_unavailable",
      };
    // Docker is the outer execution boundary: this host disallows nested browser user namespaces.
    // The browser receives one fixed local URL and no remote debugging or model commands.
    browser = Bun.spawn(
      [
        "/usr/bin/chromium-browser",
        "--headless",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        "--user-data-dir=/tmp/browser-profile",
        "http://127.0.0.1:3000/",
      ],
      {
        cwd: "/tmp",
        env: CHILD_ENV,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await Bun.sleep(2500);
  }
  transport = new StdioClientTransport({
    command:
      framework === "nextjs" ? "/usr/local/bin/node" : "/usr/local/bin/php",
    args:
      framework === "nextjs"
        ? ["/wrenly/tools/node_modules/next-devtools-mcp/dist/index.js"]
        : ["/wrenly/boost-launcher.php"],
    cwd: "/app",
    env: CHILD_ENV,
    stderr: "ignore",
  });
  const client = new Client({
    name: "wrenly-framework-inspection",
    version: "1.0.0",
  });
  try {
    await within(client.connect(transport));
    if (request.method === "resources/read") {
      const resources = await within(client.listResources());
      if (!resources.resources.some((item) => item.uri === request.params.uri))
        throw Error("Missing official resource");
      const result = await within(client.readResource(request.params));
      if (result.contents.length !== 1)
        throw Error("Unexpected resource result");
      const content = result.contents[0];
      if (
        !content ||
        !("text" in content) ||
        typeof content.text !== "string" ||
        Buffer.byteLength(content.text) > LIMITS.maximumReportBytes
      )
        throw Error("Invalid resource body");
      return {
        status: "available",
        report: applicationInformationReport(
          expected,
          JSON.parse(content.text),
        ),
      };
    }
    const tools = await within(client.listTools());
    if (
      !tools.tools.some((tool) => tool.name === "nextjs_index") ||
      !tools.tools.some((tool) => tool.name === "nextjs_call")
    )
      throw Error("Missing official tool");
    const discovery = record(
      JSON.parse(
        textResult(
          await within(
            client.callTool({
              name: "nextjs_index",
              arguments: { port: 3000 },
            }),
          ),
        ),
      ),
    );
    if (
      discovery.success !== true ||
      !Array.isArray(discovery.servers) ||
      discovery.servers.length !== 1
    )
      throw Error("Ambiguous runtime");
    const server = record(discovery.servers[0]);
    if (server.port !== 3000 || !Array.isArray(server.tools))
      throw Error("Unexpected runtime");
    const errorTool = server.tools
      .map(record)
      .find((tool) => tool.name === "get_errors");
    assertNoArgumentErrorTool(errorTool?.inputSchema);
    for (let call = 0; call < 2; call++) {
      const response = record(
        JSON.parse(textResult(await within(client.callTool(request.params)))),
      );
      if (
        response.success !== true ||
        response.port !== 3000 ||
        response.toolName !== "get_errors"
      )
        throw Error("Unexpected tool envelope");
      const state = record(JSON.parse(textResult(response.result)));
      if (typeof state.error !== "string")
        return {
          status: "available",
          report: nextRuntimeFactsReport(expected, state),
        };
      if (call === 0) await Bun.sleep(4000);
    }
    return { status: "unavailable", reason: "runtime_session_unavailable" };
  } finally {
    await client.close();
  }
}
async function main(): Promise<void> {
  try {
    process.stdout.write(JSON.stringify(await run()));
  } catch {
    process.stdout.write(
      JSON.stringify({ status: "unavailable", reason: "inspection_failed" }),
    );
  } finally {
    browser?.kill("SIGKILL");
    development?.kill("SIGKILL");
    await browser?.exited;
    await development?.exited;
    await transport?.close();
    clearTimeout(watchdog);
    process.stdin.destroy();
  }
}
void main().catch(() => {
  process.exitCode = 1;
});
