/** The Production broker must never accept client-selected databases, roles or TLS downgrades. */
import { expect, test } from "bun:test";
import { createProductionProjectCredentials } from "@wrenly/db/production-project-credentials";
import {
  productionDatabaseSocketConfiguration,
  productionSocketHostMapping,
} from "../../src/databases/production-socket-policy";
const resourceId = "a7390531-8bc3-4f74-9d70-f9812e7c064d";
const credentials = createProductionProjectCredentials(resourceId);
const upstream = {
  hostname: "apps.internal.test",
  address: "10.24.1.8",
  port: 5432,
};
const certificateAuthority =
  "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";
test("Production keeps Unix-only app alias with exact role/database and verified TLS upstream", () => {
  for (const role of ["runtime", "migrator", "reader"] as const) {
    const result = productionDatabaseSocketConfiguration({
      resourceId,
      credentials,
      role,
      upstream,
      certificateAuthority,
    });
    expect(result.configuration).toContain(
      `dbname=${credentials.database} user=${credentials[role].user}`,
    );
    expect(result.configuration).toContain("listen_addr =\n");
    expect(result.configuration).toContain("server_tls_sslmode = verify-full");
    expect(result.configuration).not.toContain("sslmode = disable");
    expect(result.authentication).toBe(
      `"${credentials[role].user}" "${credentials[role].password}"\n`,
    );
    expect(result.certificateAuthority).toBe(certificateAuthority);
  }
  expect(productionSocketHostMapping(upstream)).toBe(
    "apps.internal.test:10.24.1.8",
  );
});
test("public, loopback, injected or malformed destinations cannot become broker configuration", () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "8.8.8.8",
    "10.0.0.1\nlisten_addr=*",
  ])
    expect(() =>
      productionSocketHostMapping({ ...upstream, address }),
    ).toThrow();
  for (const hostname of [
    "10.24.1.8",
    "apps.internal.test\n",
    "apps.internal.test user=postgres",
    "localhost",
  ])
    expect(() =>
      productionSocketHostMapping({ ...upstream, hostname }),
    ).toThrow();
});
test("foreign resources, malformed CA and key material fail before secret delivery", () => {
  for (const ca of [
    "",
    "x".repeat(32769),
    "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
  ])
    expect(() =>
      productionDatabaseSocketConfiguration({
        resourceId,
        credentials,
        role: "runtime",
        upstream,
        certificateAuthority: ca,
      }),
    ).toThrow();
  expect(() =>
    productionDatabaseSocketConfiguration({
      resourceId: crypto.randomUUID(),
      credentials,
      role: "runtime",
      upstream,
      certificateAuthority,
    }),
  ).toThrow();
});
