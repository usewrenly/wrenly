/**
 * Local operator owner-recovery command.
 * Selects an existing account and issues an expiring proof; browser confirmation still requires its real sign-in.
 * Never replaces credentials or transfers projects.
 * Prints the private fragment link only to the operator console.
 */
import { parseApiEnvironment } from "../../../config/api-environment";
import { issueOwnerRecoveryProof } from "../recovery/owner-recovery-store";
if (import.meta.main) {
  try {
    const email = process.argv[2];
    if (!email || process.argv.length !== 3)
      throw new Error(
        "Usage: bun run recover-owner existing-account@example.com",
      );
    const environment = parseApiEnvironment(process.env);
    const url = new URL("/recover-owner", environment.WRENLY_WEB_URL);
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    )
      throw new Error(
        "Owner recovery requires HTTPS except on loopback development.",
      );
    const { db } = await import("@wrenly/db");
    const proof = await issueOwnerRecoveryProof(db, email);
    url.hash = `recovery=${proof}`;
    await Bun.write(
      Bun.stdout,
      `Sign in to the selected existing account, then open this private link within 10 minutes:\n${url.href}\nDo not share this link. No project ownership is transferred.\n`,
    );
    process.exit(0);
  } catch (error) {
    await Bun.write(
      Bun.stderr,
      `${error instanceof Error ? error.message : "Owner recovery could not be authorized."}\n`,
    );
    process.exit(1);
  }
}
