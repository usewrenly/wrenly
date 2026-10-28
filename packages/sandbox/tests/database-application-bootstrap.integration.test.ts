import { describe, expect, test } from "bun:test";
import Docker from "dockerode";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DATABASE_SOCKET_IMAGE } from "../src/databases/database-socket";
import { DATABASE_APPLICATION_READY } from "../src/databases/application-runtime/bootstrap";
import { LARAVEL_RUNTIME_IMAGE } from "../src/source-policy/laravel-runtime";

const integration = process.env.WRENLY_TEST_APP_DATABASE_RUNTIME === "true" ? describe : describe.skip;
const docker = new Docker({ socketPath: "/var/run/docker.sock", timeout: 10_000 });
integration("trusted application startup guardian", () => {
  test.each(["ready", "laravel-ready", "wrong-role", "oversized-deadline", "oversized-input", "stalled-input"] as const)("%s", async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-application-bootstrap-"));
    const operationId = crypto.randomUUID();
    const name = `wrenly-application-bootstrap-test-${operationId}`;
    const resourceId = crypto.randomUUID();
    const password = "c".repeat(64);
    let child: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/database-application-bootstrap.ts")],
        target: "bun", env: "disable" });
      if (!bundle.success || !bundle.outputs[0]) throw new Error("Trusted bootstrap bundle unavailable");
      const bootstrap = join(directory, "bootstrap.js");
      await writeFile(bootstrap, await bundle.outputs[0].text(), { mode: 0o644 });
      const app = join(directory, "app");
      const next = join(app, "node_modules/next/dist/bin");
      await mkdir(next, { recursive: true, mode: 0o755 });
      // Docker cannot create nested mount points inside the read-only app bind.
      // Real artifacts contain these directories; the tiny fixture must too.
      await mkdir(join(app, "bootstrap/cache"), { recursive: true, mode: 0o755 });
      await mkdir(join(app, "storage"), { mode: 0o755 });
      // A tiny test application substitutes only for Next's fixed executable. Real
      // driver/database I/O is accepted separately; this checks credential delivery,
      // privilege separation, log suppression, readiness and the independent deadline.
      await writeFile(join(next, "next"), `
        if(process.getuid()!==1000||process.getgid()!==1000)process.exit(2);
        if(process.env.PGHOST!=="/run/wrenly-database"||process.env.PGPORT!=="6432"||
          process.env.PGDATABASE!=="app"||process.env.PGPASSWORD!=="${password}")process.exit(3);
        let blocked=false;try{process.kill(1,"SIGKILL")}catch{blocked=true}
        if(!blocked)process.exit(4);
        console.log(process.env.PGPASSWORD);
        Bun.serve({port:3000,hostname:"127.0.0.1",fetch:()=>new Response("fixture ready")});
      `, { mode: 0o644 });
      await mkdir(join(app, "public"), { mode: 0o755 });
      await writeFile(join(app, "public/index.php"), `<?php
        if(getenv('DB_CONNECTION')!=='pgsql'||getenv('DB_HOST')!=='/run/wrenly-database'||
          getenv('DB_PORT')!=='6432'||getenv('DB_DATABASE')!=='app'||
          getenv('DB_PASSWORD')!=='${password}'||getenv('APP_DEBUG')!=='false'||
          !is_dir('/app/storage/framework/views')||!is_dir('/app/storage/framework/sessions')) {
          http_response_code(500); exit;
        }
        file_put_contents('php://stderr',getenv('DB_PASSWORD'));
        echo 'fixture ready';
      `, { mode: 0o644 });
      const image = await docker.getImage(scenario === "laravel-ready" ? LARAVEL_RUNTIME_IMAGE : DATABASE_SOCKET_IMAGE).inspect();
      child = Bun.spawn(["docker", "--host", "unix:///var/run/docker.sock", "run", "--name", name,
        "--interactive", "--sig-proxy=false", "--network", "none", "--read-only", "--user", "0:0",
        "--cap-drop=ALL", "--cap-add=SETUID", "--cap-add=SETGID", "--security-opt=no-new-privileges:true",
        "--memory=512m", "--cpus=0.5", "--pids-limit=64", "--log-driver=none",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=32m,uid=1000,gid=1000",
        "--tmpfs", "/app/bootstrap/cache:rw,nosuid,nodev,size=8m,uid=1000,gid=1000",
        "--tmpfs", "/app/storage:rw,nosuid,nodev,size=32m,uid=1000,gid=1000",
        "--label", `io.wrenly.test-operation=${operationId}`,
        "--mount", `type=bind,source=${bootstrap},target=/wrenly/bootstrap.js,readonly`,
        "--mount", `type=bind,source=${app},target=/app,readonly`,
        "--entrypoint", "bun", image.Id, "--no-env-file", "/wrenly/bootstrap.js"], {
        stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      });
      timer = setTimeout(() => child?.kill("SIGKILL"), 15_000);
      if (scenario !== "stalled-input") {
        child.stdin.write(scenario === "oversized-input" ? "x".repeat(8193) : JSON.stringify({
          framework: scenario === "laravel-ready" ? "laravel" : "nextjs", resourceId,
          lifetimeMs: scenario === "oversized-deadline" ? 300001 : 4000,
          role: { user: `wrenly_${resourceId.replaceAll("-", "")}_${scenario === "wrong-role" ? "admin" : "runtime"}`, password },
        }));
        child.stdin.end();
      }
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      const ready = scenario === "ready" || scenario === "laravel-ready";
      expect(code).toBe(ready || scenario === "stalled-input" ? 137 : 125);
      expect(output).toBe(ready ? `${DATABASE_APPLICATION_READY}\n` : "");
      const info = await docker.getContainer(name).inspect();
      expect(info.State.Error).toBe("");
      expect(JSON.stringify(info.Config)).not.toContain(password);
      expect(info.Config.Env?.some((value: string) => /^(PGPASSWORD|DATABASE_URL|DB_PASSWORD)=/.test(value))).toBe(false);
      expect(info.HostConfig.NetworkMode).toBe("none");
    } finally {
      if (timer) clearTimeout(timer);
      child?.kill("SIGKILL");
      try {
        const container = docker.getContainer(name);
        const info = await container.inspect();
        if (info.Config.Labels?.["io.wrenly.test-operation"] !== operationId) throw new Error("Foreign test container");
        await docker.getContainer(info.Id).remove({ force: true, v: true });
      } catch (error) {
        if (!(typeof error === "object" && error && "statusCode" in error && error.statusCode === 404)) throw error;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
