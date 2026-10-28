/** Native Better Auth password reset acceptance. Only an explicitly named disposable database is allowed. */
import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as schema from "../../../src/schema";
import { createOwnerAccount } from "../../../../../apps/api/src/modules/auth/setup/owner-account";
import { createInstanceAuth } from "../../../../../apps/api/src/modules/auth/configuration/instance-auth";
import { createSkill } from "../../../../../apps/api/src/modules/skills/skill-store";
import {
  pinInitialProjectSkills,
  freezeProjectSkills,
} from "../../../../../apps/api/src/modules/skills/project-skills";
import {
  issuePasswordRecovery,
  completePasswordRecovery,
} from "../../../../../apps/api/src/modules/auth/password-recovery/password-recovery-store";
const url = process.env.WRENLY_TEST_PASSWORD_RECOVERY_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    parsed.pathname !== "/wrenly_setup_test"
  )
    throw new Error("Use a disposable local wrenly_setup_test database only.");
}
(url ? describe : describe.skip)(
  "native private-link password recovery",
  () => {
    const client = postgres(url ?? "postgresql://localhost/wrenly_setup_test", {
      onnotice: () => {},
    });
    const database = drizzle(client, { schema });
    const config = {
      secret: "password-recovery-fixture-secret-32-characters",
      apiUrl: "http://localhost:3002",
      webUrl: "http://localhost:3000",
    };
    afterAll(async () => {
      await client.end();
    });
    test("proofs expire, native credentials change once, sessions revoke and ownership survives", async () => {
      await migrate(database, {
        migrationsFolder: `${import.meta.dir}/../../../migrations`,
      });
      const email = `recovery-${crypto.randomUUID()}@example.test`,
        password = "before-recovery-fixture";
      const userId = await database.transaction((tx) =>
        createOwnerAccount(tx, config, {
          email,
          name: "Recovery fixture",
          password,
        }),
      );
      const [project] = await database
        .insert(schema.projects)
        .values({ userId, name: "Preserved project", stack: "nextjs" })
        .returning();
      const signIn = (value: string) =>
        database.transaction((tx) =>
          createInstanceAuth(tx, config).api.signInEmail({
            body: { email, password: value },
          }),
        );
      await signIn(password);
      expect(
        (
          await database
            .select()
            .from(schema.session)
            .where(eq(schema.session.userId, userId))
        ).length,
      ).toBe(1);
      const staleProof = await issuePasswordRecovery(database, email);
      const proof = await issuePasswordRecovery(database, email);
      const input = {
        proof,
        requestId: crypto.randomUUID(),
        password: "after-recovery-fixture",
      };
      const [activeBuild] = await database
        .insert(schema.builds)
        .values({ projectId: project!.id, prompt: "Active fixture" })
        .returning();
      await expect(
        completePasswordRecovery(database, config, input),
      ).rejects.toThrow("Builds are queued or running");
      await database
        .update(schema.builds)
        .set({ status: "success" })
        .where(eq(schema.builds.id, activeBuild!.id));
      expect(await completePasswordRecovery(database, config, input)).toEqual({
        replayed: false,
      });
      expect(
        (
          await database
            .select()
            .from(schema.session)
            .where(eq(schema.session.userId, userId))
        ).length,
      ).toBe(0);
      expect(
        (
          await database
            .select()
            .from(schema.projects)
            .where(eq(schema.projects.id, project!.id))
        )[0]?.userId,
      ).toBe(userId);
      await expect(signIn(password)).rejects.toThrow();
      await signIn(input.password);
      expect(await completePasswordRecovery(database, config, input)).toEqual({
        replayed: true,
      });
      // Replaying the receipt cannot revoke the new session or mutate the password again.
      expect(
        (
          await database
            .select()
            .from(schema.session)
            .where(eq(schema.session.userId, userId))
        ).length,
      ).toBe(1);
      await expect(
        completePasswordRecovery(database, config, {
          ...input,
          password: "different-password",
        }),
      ).rejects.toThrow("already used");
      await expect(
        completePasswordRecovery(database, config, {
          ...input,
          proof: staleProof,
        }),
      ).rejects.toThrow("Account access changed");
      const expired = await issuePasswordRecovery(database, email);
      const expiredId =
        "wrenly-password-recovery:" +
        createHash("sha256").update(expired).digest("hex");
      await database
        .update(schema.verification)
        .set({ expiresAt: new Date(0) })
        .where(eq(schema.verification.id, expiredId));
      await expect(
        completePasswordRecovery(database, config, {
          ...input,
          proof: expired,
        }),
      ).rejects.toThrow("expired");
      const concurrent = {
        ...input,
        proof: await issuePasswordRecovery(database, email),
        requestId: crypto.randomUUID(),
        password: "concurrent-new-password",
      };
      const outcomes = await Promise.allSettled([
        completePasswordRecovery(database, config, concurrent),
        completePasswordRecovery(database, config, concurrent),
      ]);
      expect(outcomes.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      expect(
        await completePasswordRecovery(database, config, concurrent),
      ).toEqual({ replayed: true });
      await signIn(concurrent.password);
      const bannedProof = await issuePasswordRecovery(database, email);
      await database
        .update(schema.user)
        .set({ banned: true })
        .where(eq(schema.user.id, userId));
      await expect(
        completePasswordRecovery(database, config, {
          ...input,
          proof: bannedProof,
        }),
      ).rejects.toThrow("unavailable");
      await expect(issuePasswordRecovery(database, email)).rejects.toThrow(
        "active existing account",
      );
    }, 30_000);
    test("new project pins exact personal instructions before its first admission and rejects foreign/archived versions atomically", async () => {
      const email = `skills-${crypto.randomUUID()}@example.test`;
      const owner = await database.transaction((tx) =>
        createOwnerAccount(tx, config, {
          email,
          name: "Skills fixture",
          password: "skills-fixture-password",
        }),
      );
      const saved = await createSkill(database, owner, {
        requestId: crypto.randomUUID(),
        skillId: crypto.randomUUID(),
        document:
          "---\nname: first-prompt\ndescription: Guide the first prompt\n---\nUse concrete verbs.",
        source: "authored",
        sourceUrl: null,
        versionLabel: null,
        licenseNotes: "",
      });
      const create = (actor: string) =>
        database.transaction(async (tx) => {
          const [project] = await tx
            .insert(schema.projects)
            .values({
              userId: actor,
              name: "Initially guided",
              stack: "nextjs",
            })
            .returning();
          await pinInitialProjectSkills(tx, project!.id, actor, [
            saved.versionId,
          ]);
          return project!;
        });
      const created = await create(owner);
      const frozen = await database.transaction((tx) =>
        freezeProjectSkills(tx, created.id),
      );
      expect(frozen).toHaveLength(1);
      expect(frozen[0]?.versionId).toBe(saved.versionId);
      expect(frozen[0]?.document).toContain("Use concrete verbs.");
      const stranger = await database.transaction((tx) =>
        createOwnerAccount(tx, config, {
          email: `stranger-${crypto.randomUUID()}@example.test`,
          name: "Other fixture",
          password: "other-fixture-password",
        }),
      );
      await expect(create(stranger)).rejects.toThrow("own skill library");
      expect(
        (
          await database
            .select()
            .from(schema.projects)
            .where(eq(schema.projects.userId, stranger))
        ).length,
      ).toBe(0);
      await database
        .update(schema.skills)
        .set({ archivedAt: new Date() })
        .where(eq(schema.skills.id, saved.skillId));
      await expect(create(owner)).rejects.toThrow("own skill library");
      expect(
        (
          await database
            .select()
            .from(schema.projects)
            .where(eq(schema.projects.userId, owner))
        ).length,
      ).toBe(1);
    });
  },
);
