/** Builds a Unix-only broker configuration for one project on the private Production server. */
import { isIP } from "node:net";
import { applicationDatabaseEnvironment } from "./application-runtime/environment";
import {
  validateProductionProjectCredentials,
  type ProductionProjectCredentials,
} from "@wrenly/db/production-project-credentials";
import {
  DATABASE_SOCKET_DIRECTORY,
  DATABASE_SOCKET_PORT,
  type DatabaseSocketConfiguration,
} from "./database-resource-policy";

const SYSTEM_CERTIFICATE_PATH = "/etc/ssl/certs/ca-certificates.crt";
const CERTIFICATE_PATH = "/run/wrenly-db-config/upstream-ca.pem";
const MAX_CA_BYTES = 32 * 1024;
const MAX_CONNECTIONS = 8;
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export interface ProductionSocketConfiguration extends DatabaseSocketConfiguration {
  certificateAuthority?: string;
}
export interface ProductionSocketUpstream {
  hostname: string;
  address: string;
  port: number;
}
/** The broker uses this exact hostname mapping; TLS still validates the original hostname, not its pinned IP. */
export function productionSocketHostMapping(
  upstream: ProductionSocketUpstream,
): string {
  const octets = upstream.address.split(".").map(Number);
  const privateAddress =
    isIP(upstream.address) === 4 &&
    (octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168));
  if (
    isIP(upstream.hostname) !== 0 ||
    !HOSTNAME.test(upstream.hostname) ||
    !privateAddress ||
    !Number.isInteger(upstream.port) ||
    upstream.port < 1 ||
    upstream.port > 65535
  )
    throw new Error(
      "Production socket requires a pinned private IPv4 endpoint and verified TLS hostname.",
    );
  return `${upstream.hostname}:${upstream.address}`;
}
/** Caller must verify the cluster and pinned DNS immediately before starting the broker; configuration alone proves neither. */
export function productionDatabaseSocketConfiguration(input: {
  resourceId: string;
  credentials: ProductionProjectCredentials;
  role: "migrator" | "runtime" | "reader";
  upstream: ProductionSocketUpstream;
  certificateAuthority?: string;
}): ProductionSocketConfiguration {
  const credentials = validateProductionProjectCredentials(
    input.resourceId,
    input.credentials,
  );
  if (!["migrator", "runtime", "reader"].includes(input.role))
    throw new Error("Invalid Production socket role.");
  return scopedProductionSocketConfiguration({
    database: credentials.database,
    role: credentials[input.role],
    upstream: input.upstream,
    certificateAuthority: input.certificateAuthority,
  });
}
/** Deployment hosts receive only this runtime role; migrator/reader/management secrets stay instance-side. */
export function productionDatabaseRuntimeSocketConfiguration(input: {
  resourceId: string;
  runtimeRole: { user: string; password: string };
  upstream: ProductionSocketUpstream;
  certificateAuthority?: string;
}): ProductionSocketConfiguration {
  applicationDatabaseEnvironment("nextjs", input.resourceId, input.runtimeRole);
  return scopedProductionSocketConfiguration({
    database: `wrenly_${input.resourceId.replaceAll("-", "")}`,
    role: input.runtimeRole,
    upstream: input.upstream,
    certificateAuthority: input.certificateAuthority,
  });
}
function scopedProductionSocketConfiguration(input: {
  database: string;
  role: { user: string; password: string };
  upstream: ProductionSocketUpstream;
  certificateAuthority?: string;
}): ProductionSocketConfiguration {
  productionSocketHostMapping(input.upstream);
  const ca = input.certificateAuthority;
  if (
    ca !== undefined &&
    (!ca ||
      Buffer.byteLength(ca) > MAX_CA_BYTES ||
      !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(
        ca,
      ) ||
      ca.includes("PRIVATE KEY"))
  )
    throw new Error(
      "Production socket requires a bounded certificate authority certificate.",
    );
  const role = input.role;
  return {
    // Generated clients keep the existing local database alias; upstream identity is never client-selectable.
    configuration:
      `[databases]\napp = host=${input.upstream.hostname} port=${input.upstream.port} dbname=${input.database} user=${role.user} password=${role.password}\n\n` +
      `[pgbouncer]\nlisten_addr =\nlisten_port = ${DATABASE_SOCKET_PORT}\nunix_socket_dir = ${DATABASE_SOCKET_DIRECTORY}\nunix_socket_mode = 0777\n` +
      `auth_type = scram-sha-256\nauth_file = /run/wrenly-db-config/users.txt\npool_mode = session\nmax_client_conn = ${MAX_CONNECTIONS}\n` +
      `default_pool_size = ${MAX_CONNECTIONS}\nmax_db_connections = ${MAX_CONNECTIONS}\nmax_user_connections = ${MAX_CONNECTIONS}\n` +
      `server_tls_sslmode = verify-full\nserver_tls_ca_file = ${ca === undefined ? SYSTEM_CERTIFICATE_PATH : CERTIFICATE_PATH}\nserver_connect_timeout = 5\nlog_connections = 0\nlog_disconnections = 0\n`,
    authentication: `"${role.user}" "${role.password}"\n`,
    ...(ca === undefined ? {} : { certificateAuthority: ca }),
  };
}
