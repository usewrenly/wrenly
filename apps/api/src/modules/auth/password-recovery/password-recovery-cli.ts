/** Prints a private recovery link on the instance server, never a password or session. */
import { parseApiEnvironment } from "../../../config/api-environment";
import { issuePasswordRecovery } from "./password-recovery-store";
if (import.meta.main) {
  try {
    const email = process.argv[2];
    if (!email || process.argv.length !== 3)
      throw new Error(
        "Usage: bun run recover-password existing-account@example.com",
      );
    const environment = parseApiEnvironment(process.env);
    const url = new URL("/reset-password", environment.WRENLY_WEB_URL);
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    )
      throw new Error(
        "Password recovery requires HTTPS except on loopback development.",
      );
    const { db } = await import("@wrenly/db");
    url.hash = `recovery=${await issuePasswordRecovery(db, email)}`;
    await Bun.write(
      Bun.stdout,
      `Open this private link within 10 minutes:\n${url.href}\nDo not share it. Completing recovery signs out this account's existing sessions.\n`,
    );
    process.exit(0);
  } catch (error) {
    await Bun.write(
      Bun.stderr,
      `${error instanceof Error ? error.message : "Recovery could not be authorized."}\n`,
    );
    process.exit(1);
  }
}
