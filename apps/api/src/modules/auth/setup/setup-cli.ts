/**
 * Local operator setup command.
 * Issues an expiring first-owner proof and prints a private browser link once.
 * Proof is carried in the fragment, never a public minting endpoint or application log.
 * Browser credentials are created through the protected setup flow.
 */
import { parseApiEnvironment } from "../../../config/api-environment";
import { issueOwnerSetupProof } from "./instance-setup-store";
if (import.meta.main) {
  try {
    const environment = parseApiEnvironment(process.env);
    const url = new URL("/setup", environment.WRENLY_WEB_URL);
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    )
      throw new Error(
        "Browser owner setup requires HTTPS except on loopback development.",
      );
    const { db } = await import("@wrenly/db");
    const proof = await issueOwnerSetupProof(db);
    url.hash = `setup=${proof}`;
    // Explicit operator console output, never the API logger or a public endpoint.
    await Bun.write(
      Bun.stdout,
      `Open this private setup link in your browser within 10 minutes:\n${url.href}\nDo not share this one-time link.\n`,
    );
    process.exit(0);
  } catch (error) {
    await Bun.write(
      Bun.stderr,
      `${error instanceof Error ? error.message : "Setup proof could not be issued."}\n`,
    );
    process.exit(1);
  }
}
