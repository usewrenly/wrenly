/** Exercises observed Docker failures without running generated code or contacting Docker. */
import { expect, test, spyOn } from 'bun:test';
import Docker from 'dockerode';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDatabaseValidationArtifact, RuntimeArtifactCompilationError } from '../../src/artifacts/runtime-artifact';
import { readAppDatabaseManifest } from '../../src/databases/database-manifest';

for (const scenario of ['compiler', 'large-output', 'timeout', 'transport', 'cleanup', 'aborted', 'logs'] as const) {
  test(`only a confirmed compiler exit and cleanup is repairable (${scenario})`, async () => {
    const id = crypto.randomUUID();
    const labels = { 'io.wrenly.deployment-id': id, 'io.wrenly.artifact-role': 'preparation' };
    const files = [
      { path: 'wrenly.app.json', content: JSON.stringify({ version: 1, database: { engine: 'postgresql', adapter: 'drizzle-postgres', migrations: ['drizzle/0000_notes.sql'] } }) },
      { path: 'drizzle/0000_notes.sql', content: 'CREATE TABLE notes(id integer PRIMARY KEY);' },
      { path: 'drizzle/meta/_journal.json', content: JSON.stringify({ dialect: 'postgresql', entries: [{ idx: 0, tag: '0000_notes', when: 1, breakpoints: true }] }) },
    ];
    const controller = new AbortController();
    const output = Buffer.from(scenario === 'large-output' ? 'x'.repeat(32 * 1024) + 'Type error: final diagnostic' : 'Type error: fixture component requires title.');
    const header = Buffer.alloc(8); header[0] = 2; header.writeUInt32BE(output.length, 4);
    let created = 0, removed = 0, volumeRemoved = false;
    const spies = [
      spyOn(Docker.prototype, 'getImage').mockReturnValue({ inspect: async () => ({ Id: 'sha256:fixture' }) } as unknown as Docker.Image),
      spyOn(Docker.prototype, 'listVolumes').mockResolvedValue({ Volumes: [], Warnings: [] }),
      spyOn(Docker.prototype, 'createVolume').mockResolvedValue({} as Docker.VolumeCreateResponse),
      spyOn(Docker.prototype, 'getVolume').mockReturnValue({ name: `wrenly-artifact-${id}`, inspect: async () => ({ Name: `wrenly-artifact-${id}`, Labels: labels }), remove: async () => { volumeRemoved = true; } } as unknown as Docker.Volume),
      spyOn(Docker.prototype, 'createContainer').mockImplementation(async (options) => {
        created++;
        const compile = created === 3;
        if (compile) expect(options?.HostConfig?.NetworkMode).toBe('none');
        return {
          start: async () => {}, kill: async () => {},
          wait: async () => {
            if (compile && scenario === 'transport') throw new Error('wait acknowledgement lost');
            if (compile && scenario === 'aborted') controller.abort();
            return { StatusCode: compile ? scenario === 'timeout' ? 137 : 1 : 0 };
          },
          logs: async () => { if (scenario === 'logs') throw new Error('logs unavailable'); return Buffer.concat([header, output]); },
          remove: async () => { removed++; if (compile && scenario === 'cleanup') throw new Error('cleanup not confirmed'); },
        } as unknown as Docker.Container;
      }),
    ];
    try {
      let caught: unknown;
      try {
        await prepareDatabaseValidationArtifact({ deploymentId: id, stack: 'nextjs', files,
          migrationDigest: readAppDatabaseManifest(files, 'nextjs')!.digest,
          signal: controller.signal, beforeEffect: async () => {},
        });
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect(caught instanceof RuntimeArtifactCompilationError).toBe(scenario === 'compiler' || scenario === 'large-output');
      expect(created).toBe(3); expect(removed).toBe(3);
      expect(volumeRemoved).toBe(scenario !== 'cleanup');
      if (caught instanceof RuntimeArtifactCompilationError) {
        expect(caught.operationId).toBe(id); expect(caught.exitCode).toBe(1);
        expect(caught.output).toBe(output.subarray(-16 * 1024).toString());
        expect(Buffer.byteLength(caught.output)).toBeLessThanOrEqual(16 * 1024);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      for (const name of await readdir(tmpdir())) {
        if (name.startsWith(`wrenly-artifact-${id}-`)) await rm(join(tmpdir(), name), { recursive: true, force: true });
      }
    }
  });
}
