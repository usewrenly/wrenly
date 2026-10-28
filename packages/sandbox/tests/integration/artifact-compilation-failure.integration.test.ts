/** Opt-in trusted fixture: proves actual Docker exit/log decoding and preparation cleanup. */
import { expect, test } from 'bun:test';
import Docker from 'dockerode';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { prepareDatabaseValidationArtifact, RuntimeArtifactCompilationError } from '../../src/artifacts/runtime-artifact';
import { readAppDatabaseManifest } from '../../src/databases/database-manifest';
const acceptance = process.env.WRENLY_TEST_ARTIFACT_COMPILATION === '1' ? test : test.skip;
acceptance('observed offline compiler exit retains bounded diagnostics only after Docker cleanup', async () => {
  const id = crypto.randomUUID();
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: 'wrenly-compiler-fixture', scripts: { build: 'bun compile.ts' } }) },
    { path: 'compile.ts', content: 'throw new Error("WRENLY_TRUSTED_COMPILER_FIXTURE");' },
    { path: 'wrenly.app.json', content: JSON.stringify({ version: 1, database: { engine: 'postgresql', adapter: 'drizzle-postgres', migrations: ['drizzle/0000_notes.sql'] } }) },
    { path: 'drizzle/0000_notes.sql', content: 'CREATE TABLE notes(id integer PRIMARY KEY);' },
    { path: 'drizzle/meta/_journal.json', content: JSON.stringify({ dialect: 'postgresql', entries: [{ idx: 0, tag: '0000_notes', when: 1, breakpoints: true }] }) },
  ];
  let failure: unknown;
  try {
    await prepareDatabaseValidationArtifact({ deploymentId: id, stack: 'nextjs', files,
      migrationDigest: readAppDatabaseManifest(files, 'nextjs')!.digest,
      signal: new AbortController().signal, beforeEffect: async () => {},
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(RuntimeArtifactCompilationError);
  if (!(failure instanceof RuntimeArtifactCompilationError)) throw failure;
  expect(failure.operationId).toBe(id);
  expect(failure.output).toContain('WRENLY_TRUSTED_COMPILER_FIXTURE');
  expect(Buffer.byteLength(failure.output)).toBeLessThanOrEqual(16 * 1024 + 3);
  const docker = new Docker({ socketPath: '/var/run/docker.sock', timeout: 10_000 });
  const filters = JSON.stringify({ label: [`io.wrenly.deployment-id=${id}`] });
  expect(await docker.listContainers({ all: true, filters })).toHaveLength(0);
  expect((await docker.listVolumes({ filters })).Volumes ?? []).toHaveLength(0);
  expect(await docker.listImages({ filters })).toHaveLength(0);
  expect((await readdir(tmpdir())).filter(name => name.startsWith(`wrenly-artifact-${id}-`))).toHaveLength(0);
}, 60_000);
