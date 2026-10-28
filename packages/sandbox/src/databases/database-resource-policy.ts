// Derives and checks exact database resource names, ownership labels and socket policy.
// Matching a name alone never proves ownership; environment/project/resource identities must agree.
import { isIP } from "node:net";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const RESOURCE_LABEL = "io.wrenly.database-id";
const PROJECT_LABEL = "io.wrenly.project-id";
const ENVIRONMENT_LABEL = "io.wrenly.database-environment";
const ROLE_LABEL = "io.wrenly.role";
const DATA_DIRECTORY = "/var/lib/postgresql/data";
export const DATABASE_SOCKET_DIRECTORY = "/run/wrenly-database";
export const DATABASE_SOCKET_PORT = 6432;
export const DATABASE_SOCKET_PATH = `${DATABASE_SOCKET_DIRECTORY}/.s.PGSQL.${DATABASE_SOCKET_PORT}`;
const MAX_CONNECTIONS = 8;
const DATABASE_PORT = 5432;
const SOCKET_AUTH_FILE = "/run/wrenly-db-config/users.txt";

export interface ManagedDatabaseScope {
  resourceId: string;
  projectId: string;
  environment: "development";
}
export interface ManagedDatabaseNames {
  container: string;
  volume: string;
  network: string;
}
type ResourceKind =
  | "database"
  | "database-data"
  | "database-network"
  | "database-initializer"
  | "database-socket"
  | "database-administrator"
  | "database-backup"
  | "database-query"
  | "database-migration"
  | "database-application";
interface Labelled {
  Labels?: Record<string, string> | null;
}
export interface ManagedDatabaseInspection {
  volume: Labelled & {
    Name: string;
    Driver: string;
    Options?: Record<string, string> | null;
  };
  network: Labelled & {
    Id: string;
    Name: string;
    Internal: boolean;
    Driver: string;
    EnableIPv6?: boolean;
  };
  container: {
    State?: { Running: boolean };
    Id: string;
    Name: string;
    Image: string;
    Config: Labelled & { User: string; Env?: string[] };
    HostConfig: {
      Privileged?: boolean;
      NetworkMode?: string;
      PortBindings?: Record<string, unknown> | null;
      ReadonlyRootfs?: boolean;
      CapDrop?: string[] | null;
      CapAdd?: string[] | null;
      SecurityOpt?: string[] | null;
    };
    NetworkSettings: {
      Networks?: Record<string, { NetworkID: string; IPAddress: string }>;
      Ports?: Record<string, unknown> | null;
    };
    Mounts: Array<{ Type: string; Name?: string; Destination: string }>;
  };
}

function validateScope(scope: ManagedDatabaseScope): void {
  if (
    !UUID.test(scope.resourceId) ||
    !UUID.test(scope.projectId) ||
    scope.environment !== "development"
  )
    throw new Error(
      "Managed database identity must name one Development project resource.",
    );
}
/** Explicit names prevent Docker handle/type mismatches from mounting an undefined or shared volume. */
export function managedDatabaseNames(
  scope: ManagedDatabaseScope,
): ManagedDatabaseNames {
  validateScope(scope);
  const prefix = `wrenly-database-${scope.resourceId}`;
  return {
    container: prefix,
    volume: `${prefix}-data`,
    network: `${prefix}-network`,
  };
}
/** Labels bind persistent resources to their project, environment and purpose. */
export function managedDatabaseLabels(
  scope: ManagedDatabaseScope,
  kind: ResourceKind,
): Record<string, string> {
  validateScope(scope);
  return {
    [RESOURCE_LABEL]: scope.resourceId,
    [PROJECT_LABEL]: scope.projectId,
    [ENVIRONMENT_LABEL]: scope.environment,
    [ROLE_LABEL]: kind,
  };
}
/** Checks every ownership dimension before a runtime resource may be used or removed. */
export function assertManagedDatabaseLabels(
  actual: Labelled,
  scope: ManagedDatabaseScope,
  kind: ResourceKind,
): void {
  for (const [key, value] of Object.entries(managedDatabaseLabels(scope, kind)))
    if (actual.Labels?.[key] !== value)
      throw new Error("Database resource ownership could not be verified.");
}
function privateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

/** Refuses foreign, missing, public or retargeted resources before starting or connecting to a saved database. */
export function verifyManagedDatabaseResources(
  scope: ManagedDatabaseScope,
  expected: {
    containerId: string;
    networkId: string;
    volumeName: string;
    imageId: string;
  },
  inspection: ManagedDatabaseInspection,
  options: { allowStopped?: boolean } = {},
): { address: string; port: number } {
  const names = managedDatabaseNames(scope);
  if (
    !IMAGE_ID.test(expected.imageId) ||
    !expected.containerId ||
    !expected.networkId ||
    expected.volumeName !== names.volume
  )
    throw new Error(
      "A complete saved database identity is required; do not initialize replacement data.",
    );
  const { volume, network, container } = inspection;
  assertManagedDatabaseLabels(volume, scope, "database-data");
  assertManagedDatabaseLabels(network, scope, "database-network");
  assertManagedDatabaseLabels(container.Config, scope, "database");
  if (
    volume.Name !== expected.volumeName ||
    volume.Driver !== "local" ||
    Object.keys(volume.Options ?? {}).length
  )
    throw new Error(
      "Database data volume name, driver or mount options changed.",
    );
  if (
    network.Id !== expected.networkId ||
    network.Name !== names.network ||
    !network.Internal ||
    network.Driver !== "bridge" ||
    network.EnableIPv6
  )
    throw new Error(
      "Database network must be the saved private project bridge.",
    );
  if (
    container.Id !== expected.containerId ||
    container.Name !== `/${names.container}` ||
    container.Image !== expected.imageId ||
    container.Config.User !== "70:70" ||
    container.Config.Env?.some((value) =>
      /^(POSTGRES_PASSWORD|POSTGRES_PASSWORD_FILE|PGPASSWORD)=/.test(value),
    ) ||
    container.HostConfig.Privileged ||
    !container.HostConfig.ReadonlyRootfs ||
    !container.HostConfig.CapDrop?.includes("ALL") ||
    Boolean(container.HostConfig.CapAdd?.length) ||
    !container.HostConfig.SecurityOpt?.includes("no-new-privileges:true") ||
    ![expected.networkId, names.network].includes(
      container.HostConfig.NetworkMode ?? "",
    ) ||
    Object.keys(container.HostConfig.PortBindings ?? {}).length ||
    Object.values(container.NetworkSettings.Ports ?? {}).some(
      (binding) => binding !== null,
    )
  )
    throw new Error(
      "Database container identity, isolation or published ports changed.",
    );
  const mounts = container.Mounts;
  if (
    mounts.length !== 1 ||
    mounts[0]?.Type !== "volume" ||
    mounts[0].Name !== expected.volumeName ||
    mounts[0].Destination !== DATA_DIRECTORY
  )
    throw new Error(
      "Database container must mount only its exact persistent data volume.",
    );
  const connections = Object.values(container.NetworkSettings.Networks ?? {});
  if (
    connections.length !== 1 ||
    connections[0]?.NetworkID !== expected.networkId ||
    !(
      privateIpv4(connections[0].IPAddress) ||
      (options.allowStopped &&
        container.State?.Running === false &&
        connections[0].IPAddress === "")
    )
  )
    throw new Error(
      "Database upstream must be the inspected private address on its sole project network.",
    );
  return { address: connections[0].IPAddress, port: DATABASE_PORT };
}

export interface DatabaseSocketConfiguration {
  configuration: string;
  authentication: string;
}
/** Produces only local, fixed-upstream, Unix-listening PgBouncer configuration; callers protect these secret files. */
export function localDatabaseSocketConfiguration(
  scope: ManagedDatabaseScope,
  upstream: { address: string; port: number },
  role: {
    kind: "runtime" | "migrator" | "reader";
    user: string;
    password: string;
  },
): DatabaseSocketConfiguration {
  validateScope(scope);
  const suffix = role.kind === "migrator" ? "migrate" : role.kind;
  if (
    !["runtime", "migrator", "reader"].includes(role.kind) ||
    role.user !== `wrenly_${scope.resourceId.replaceAll("-", "")}_${suffix}` ||
    !/^[a-f0-9]{64}$/.test(role.password) ||
    !privateIpv4(upstream.address) ||
    upstream.port !== DATABASE_PORT
  )
    throw new Error(
      "Database socket requires one scoped application role and verified private PostgreSQL upstream.",
    );
  return {
    configuration:
      `[databases]\napp = host=${upstream.address} port=${upstream.port} dbname=app user=${role.user} password=${role.password}\n\n` +
      `[pgbouncer]\nlisten_addr =\nlisten_port = ${DATABASE_SOCKET_PORT}\nunix_socket_dir = ${DATABASE_SOCKET_DIRECTORY}\nunix_socket_mode = 0777\n` +
      `auth_type = scram-sha-256\nauth_file = ${SOCKET_AUTH_FILE}\npool_mode = session\nmax_client_conn = ${MAX_CONNECTIONS}\n` +
      `default_pool_size = ${MAX_CONNECTIONS}\nmax_db_connections = ${MAX_CONNECTIONS}\nmax_user_connections = ${MAX_CONNECTIONS}\n` +
      "server_tls_sslmode = disable\nserver_connect_timeout = 5\nlog_connections = 0\nlog_disconnections = 0\n",
    authentication: `"${role.user}" "${role.password}"\n`,
  };
}
