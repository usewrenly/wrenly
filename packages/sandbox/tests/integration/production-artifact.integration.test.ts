/** Optional native image preparation only; no live database, provider or deployment is contacted. */
import { expect, test } from "bun:test";
import Docker from "dockerode";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProductionDatabaseArtifact } from "../../src/artifacts/runtime-artifact";
import { readAppDatabaseManifest } from "../../src/databases/database-manifest";
const native =
  process.env.WRENLY_TEST_PRODUCTION_ARTIFACT === "true" ? test : test.skip;
native(
  "Production images carry the trusted guardian without runtime credentials",
  async () => {
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-production-artifact-test-"),
    );
    let imageId: string | undefined;
    try {
      const output = join(directory, "guardian.js");
      const build = Bun.spawn(
        [
          "bun",
          "--no-env-file",
          "build",
          join(
            import.meta.dir,
            "../../src/deployment-runtime/application-entry.mts",
          ),
          "--target=bun",
          "--env=disable",
          `--outfile=${output}`,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      if ((await build.exited) !== 0)
        throw new Error("Trusted fixture guardian bundle failed.");
      const files = [
        {
          path: "package.json",
          content: JSON.stringify({
            name: "production-artifact-fixture",
            scripts: { build: "next build" },
            dependencies: {
              next: "15.5.28",
              react: "19.3.1",
              "react-dom": "19.3.1",
            },
          }),
        },
        {
          path: "next.config.mjs",
          content: "export default { experimental: { cpus: 1 } }",
        },
        {
          path: "app/layout.jsx",
          content:
            "export default function Layout({children}) { return <html><body>{children}</body></html> }",
        },
        {
          path: "app/page.jsx",
          content:
            "export const dynamic = 'force-dynamic'; export default function Page() { return <main>Production artifact fixture</main> }",
        },
        {
          path: "wrenly.app.json",
          content: JSON.stringify({
            version: 1,
            database: {
              engine: "postgresql",
              adapter: "drizzle-postgres",
              migrations: ["drizzle/0000_notes.sql"],
            },
          }),
        },
        {
          path: "drizzle/0000_notes.sql",
          content: "CREATE TABLE notes(id integer PRIMARY KEY);",
        },
        {
          path: "drizzle/meta/_journal.json",
          content: JSON.stringify({
            dialect: "postgresql",
            entries: [
              { idx: 0, tag: "0000_notes", when: 1, breakpoints: true },
            ],
          }),
        },
      ];
      const manifest = readAppDatabaseManifest(files, "nextjs");
      if (!manifest) throw new Error("Missing fixture manifest.");
      const artifact = await prepareProductionDatabaseArtifact({
        deploymentId: crypto.randomUUID(),
        stack: "nextjs",
        files,
        migrationDigest: manifest.digest,
        bootstrap: await readFile(output),
        signal: AbortSignal.timeout(290_000),
        beforeEffect: async () => {},
      });
      imageId = artifact.imageId;
      const image = await docker.getImage(imageId).inspect();
      expect(image.Config.User).toBe("0:0");
      expect(image.Config.Entrypoint).toEqual([
        "bun",
        "--no-env-file",
        "/wrenly/production-application.js",
      ]);
      expect(image.Config.Cmd ?? []).toEqual([]);
      expect(image.Config.Labels?.["io.wrenly.database-runtime-version"]).toBe(
        "1",
      );
      expect(
        image.Config.Env?.some((value) => /PGPASSWORD|DB_PASSWORD/.test(value)),
      ).toBe(false);
    } finally {
      if (imageId) await docker.getImage(imageId).remove({ force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
  300_000,
);
