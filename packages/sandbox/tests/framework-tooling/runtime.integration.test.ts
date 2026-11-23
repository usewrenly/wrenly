/** Opt-in real official MCP acceptance; only explicitly prepared public fixtures may be mutated. */
import { expect, test } from "bun:test";
import { readFile, writeFile, access } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import Docker from "dockerode";
import { inspectInstalledFramework } from "../../src/framework-tooling/runtime";
const native =
  process.env.WRENLY_TEST_FRAMEWORK_INSPECTION === "true" ? test : test.skip;
const root = process.env.WRENLY_TEST_FRAMEWORK_FIXTURES;
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
async function fixture(framework: "laravel" | "nextjs"): Promise<string> {
  if (
    !root ||
    !isAbsolute(root) ||
    (await readFile(join(root, ".wrenly-test-owned"), "utf8")).trim() !==
      "wrenly-framework-inspection-fixtures-v1"
  )
    throw Error("Explicit prepared public fixtures required");
  return join(root, framework);
}
async function inspect(
  framework: "laravel" | "nextjs",
  signal = new AbortController().signal,
) {
  const buildId = crypto.randomUUID(),
    claimToken = crypto.randomUUID();
  const directory = await fixture(framework);
  try {
    return await inspectInstalledFramework({
      framework,
      directory,
      files: [
        { path: "fixture", content: "Public native inspection acceptance" },
      ],
      buildId,
      claimToken,
      signal,
    });
  } finally {
    const remaining = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`io.wrenly.build-id=${buildId}`] }),
    });
    expect(remaining).toHaveLength(0);
  }
}
native(
  "real Boost resource reports Laravel package facts offline without database access",
  async () => {
    const result = await inspect("laravel");
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.report.framework).toBe("laravel");
      expect("packages" in result.report.facts).toBe(true);
      expect(JSON.stringify(result)).not.toContain("database_engine");
    }
  },
  60_000,
);
native(
  "real Next DevTools reads a fixed isolated browser session",
  async () => {
    const result = await inspect("nextjs");
    expect(result.status).toBe("available");
    if (result.status === "available")
      expect(result.report.facts).toEqual({ errors: [] });
  },
  60_000,
);
native(
  "official Next runtime detects a known generated page error",
  async () => {
    const path = join(await fixture("nextjs"), "app/page.js");
    const original = await readFile(path, "utf8");
    try {
      await writeFile(
        path,
        "export default function Page(){throw new Error('WRENLY_EXPECTED_FRAMEWORK_ERROR')}\n",
      );
      const result = await inspect("nextjs");
      expect(result.status).toBe("available");
      if (result.status === "available")
        expect(JSON.stringify(result.report.facts)).toContain(
          "WRENLY_EXPECTED_FRAMEWORK_ERROR",
        );
    } finally {
      await writeFile(path, original);
    }
  },
  60_000,
);
native(
  "abort stops exact native execution and removes its container",
  async () => {
    const directory = await fixture("laravel"),
      path = join(directory, "bootstrap/app.php"),
      original = await readFile(path, "utf8");
    try {
      await writeFile(path, original.replace("<?php", "<?php sleep(120);"));
      const abort = new AbortController();
      const timer = setTimeout(
        () => abort.abort(Error("Fixture cancellation")),
        800,
      );
      try {
        await expect(inspect("laravel", abort.signal)).rejects.toThrow(
          "Fixture cancellation",
        );
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await writeFile(path, original);
    }
  },
  15_000,
);
native(
  "generated bootstrap cannot write saved source or reach the host network",
  async () => {
    const directory = await fixture("laravel"),
      path = join(directory, "bootstrap/app.php"),
      original = await readFile(path, "utf8");
    try {
      await writeFile(
        path,
        original.replace(
          "<?php",
          `<?php
if (@file_put_contents('/app/forbidden-inspection-write','bad') !== false) throw new Exception('write permitted');
$context=stream_context_create(['http'=>['timeout'=>1]]);
if (@file_get_contents('http://172.17.0.1:3002/api/health',false,$context) !== false) throw new Exception('host reached');
`,
        ),
      );
      const result = await inspect("laravel");
      expect(result.status).toBe("available");
      await expect(
        access(join(directory, "forbidden-inspection-write")),
      ).rejects.toThrow();
    } finally {
      await writeFile(path, original);
    }
  },
  60_000,
);
native(
  "native deadline stops a hung generated bootstrap and confirms cleanup",
  async () => {
    const directory = await fixture("laravel"),
      path = join(directory, "bootstrap/app.php"),
      original = await readFile(path, "utf8");
    try {
      await writeFile(path, original.replace("<?php", "<?php sleep(120);"));
      const start = performance.now();
      const result = await inspect("laravel");
      expect(result.status).toBe("unavailable");
      expect(performance.now() - start).toBeLessThan(55_000);
    } finally {
      await writeFile(path, original);
    }
  },
  60_000,
);

native(
  "older Next.js reports unsupported without starting a development server or upgrading",
  async () => {
    const path = join(
        await fixture("nextjs"),
        "node_modules/next/package.json",
      ),
      original = await readFile(path, "utf8");
    try {
      const metadata = JSON.parse(original) as { version: string };
      metadata.version = "15.5.28";
      await writeFile(path, JSON.stringify(metadata));
      const result = await inspect("nextjs");
      expect(result).toEqual({
        status: "unavailable",
        reason: "unsupported_version",
      });
    } finally {
      await writeFile(path, original);
    }
  },
  15_000,
);
