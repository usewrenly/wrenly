/** Read-only inspection of an uncertain setup phase. Names alone never prove that Wrenly created a role. */
import {
  createHash,
  createHmac,
  pbkdf2Sync,
  timingSafeEqual,
} from "node:crypto";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  validateProductionProjectCredentials,
  ProductionProvisionPhase,
  type ProductionClusterIdentity,
} from "./contract";
export type ProductionPhaseInspection = "confirmed" | "absent" | "review";
const MAX_SCRAM_ITERATIONS = 100_000;
/** Generated passwords are ASCII hex, so SCRAM password normalization cannot change their bytes. */
function matchesScram(verifier: unknown, password: string): boolean {
  if (typeof verifier !== "string" || verifier.length > 1024) return false;
  const parts =
    /^SCRAM-SHA-256\$(\d{1,6}):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(
      verifier,
    );
  if (!parts) return false;
  const iterations = Number(parts[1]);
  if (iterations < 1 || iterations > MAX_SCRAM_ITERATIONS) return false;
  const salt = Buffer.from(parts[2]!, "base64"),
    stored = Buffer.from(parts[3]!, "base64"),
    server = Buffer.from(parts[4]!, "base64");
  if (
    salt.length < 8 ||
    salt.length > 64 ||
    stored.length !== 32 ||
    server.length !== 32
  )
    return false;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const client = createHmac("sha256", salted).update("Client Key").digest();
  // SHA-256(ClientKey) is the stored-key proof; compare both proofs without returning either verifier.
  const expectedStored = createHash("sha256").update(client).digest();
  const expectedServer = createHmac("sha256", salted)
    .update("Server Key")
    .digest();
  return (
    timingSafeEqual(Buffer.from(expectedStored), stored) &&
    timingSafeEqual(expectedServer, server)
  );
}
/** Uses privileged read-only metadata on the saved cluster; never changes passwords, grants, databases or data. */
async function inspectProjectPolicy(
  database: PostgresJsDatabase,
  identity: ProductionClusterIdentity,
  resourceId: string,
  raw: unknown,
  phase: ProductionProvisionPhase,
  requireEmptySchema: boolean,
): Promise<ProductionPhaseInspection> {
  const credentials = validateProductionProjectCredentials(resourceId, raw);
  ProductionProvisionPhase.parse(phase);
  if (
    !/^[0-9]{1,20}$/.test(identity.appClusterId) ||
    !/^[0-9]{1,20}$/.test(identity.controlClusterId) ||
    identity.appClusterId === identity.controlClusterId
  )
    throw new Error("Invalid Production cluster identity");
  try {
    return await database.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const authority =
        await tx.execute(sql`select (select system_identifier::text from pg_catalog.pg_control_system()) as cluster_id,
        (select rolsuper from pg_catalog.pg_roles where rolname=current_user) as administrator,
        pg_catalog.pg_is_in_recovery() as replica, current_database() as database_name`);
      if (
        authority.length !== 1 ||
        authority[0]?.cluster_id !== identity.appClusterId ||
        authority[0]?.administrator !== true ||
        authority[0]?.replica !== false
      )
        throw new Error("Production inspection identity changed");
      const roles =
        await tx.execute(sql`select r.rolname as name, r.rolpassword as verifier,
        (r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and not r.rolbypassrls and not r.rolinherit and r.rolconnlimit=8 and r.rolvaliduntil is null and not exists(select 1 from pg_catalog.pg_db_role_setting settings where settings.setrole=r.oid and settings.setdatabase=0)) as restricted,
        exists(select 1 from pg_catalog.pg_auth_members m where m.roleid=r.oid or m.member=r.oid) as membership
        from pg_catalog.pg_authid r where r.rolname in (${credentials.migrator.user},${credentials.runtime.user},${credentials.reader.user})`);
      const databases =
        await tx.execute(sql`select d.oid::integer as id, r.rolname as owner, d.datallowconn as connected, d.datacl is null as default_acl,
        exists(select 1 from pg_catalog.pg_db_role_setting s where s.setdatabase=d.oid and s.setrole=0) as global_settings
        from pg_catalog.pg_database d join pg_catalog.pg_roles r on r.oid=d.datdba where d.datname=${credentials.database}`);
      if (phase === "roles" && roles.length === 0 && databases.length === 0)
        return "absent";
      if (roles.length !== 3) return "review";
      for (const expected of [
        credentials.migrator,
        credentials.runtime,
        credentials.reader,
      ]) {
        const role = roles.find((row) => row.name === expected.user);
        if (
          !role ||
          role.restricted !== true ||
          role.membership !== false ||
          !matchesScram(role.verifier, expected.password)
        )
          return "review";
      }
      if (phase === "roles")
        return databases.length === 0 ? "confirmed" : "review";
      if (phase === "database" && databases.length === 0) return "absent";
      const saved = databases[0];
      if (
        databases.length !== 1 ||
        saved?.owner !== credentials.migrator.user ||
        saved.global_settings !== false
      )
        return "review";
      if (phase === "database")
        return saved.connected === false && saved.default_acl === true
          ? "confirmed"
          : "review";
      if (
        phase === "connections" &&
        saved.connected === false &&
        saved.default_acl === true
      )
        return "absent";
      if (saved.connected !== true) return "review";
      const acl =
        await tx.execute(sql`select x.grantee::integer as grantee, coalesce(r.rolname,'PUBLIC') as name, x.privilege_type as privilege, x.is_grantable as grantable
        from pg_catalog.pg_database d cross join lateral pg_catalog.aclexplode(d.datacl) x left join pg_catalog.pg_roles r on r.oid=x.grantee where d.datname=${credentials.database}`);
      const allowed = new Map([
        [
          credentials.migrator.user,
          new Set(["CONNECT", "CREATE", "TEMPORARY"]),
        ],
        [credentials.runtime.user, new Set(["CONNECT"])],
        [credentials.reader.user, new Set(["CONNECT"])],
      ]);
      if (
        !acl.length ||
        acl.some(
          (row) =>
            row.grantee === 0 ||
            !allowed.get(String(row.name))?.has(String(row.privilege)) ||
            row.grantable === true,
        ) ||
        [credentials.runtime.user, credentials.reader.user].some(
          (user) =>
            !acl.some(
              (row) => row.name === user && row.privilege === "CONNECT",
            ),
        )
      )
        return "review";
      if (phase === "connections") return "confirmed";
      if (authority[0]?.database_name !== credentials.database) return "review";
      const objects = await tx.execute(
        sql`select exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','f','S')) or exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public') as present`,
      );
      if (requireEmptySchema && objects[0]?.present !== false) return "review";
      const schemas = await tx.execute(
        sql`select r.rolname as owner, n.oid::integer as id from pg_catalog.pg_namespace n join pg_catalog.pg_roles r on r.oid=n.nspowner where n.nspname='public'`,
      );
      const schema = schemas[0];
      if (schemas.length !== 1) return "review";
      const defaults =
        await tx.execute(sql`select r.rolname as owner, d.defaclobjtype as object_type, coalesce(g.rolname,'PUBLIC') as grantee, x.privilege_type as privilege, x.is_grantable as grantable
        from pg_catalog.pg_default_acl d join pg_catalog.pg_roles r on r.oid=d.defaclrole cross join lateral pg_catalog.aclexplode(d.defaclacl) x left join pg_catalog.pg_roles g on g.oid=x.grantee
        where d.defaclnamespace=${Number(schema!.id)} and d.defaclrole in (select oid from pg_catalog.pg_roles where rolname in (${credentials.migrator.user},${credentials.runtime.user},${credentials.reader.user}))`);
      const settings = await tx.execute(
        sql`select r.rolname as name, pg_catalog.to_jsonb(s.setconfig) as settings from pg_catalog.pg_db_role_setting s join pg_catalog.pg_roles r on r.oid=s.setrole where s.setdatabase=${Number(saved.id)} and r.rolname in (${credentials.migrator.user},${credentials.runtime.user},${credentials.reader.user})`,
      );
      const schemaAcl = await tx.execute(
        sql`select coalesce(r.rolname,'PUBLIC') as name, x.privilege_type as privilege, x.is_grantable as grantable from pg_catalog.pg_namespace n cross join lateral pg_catalog.aclexplode(n.nspacl) x left join pg_catalog.pg_roles r on r.oid=x.grantee where n.nspname='public'`,
      );
      if (
        schema?.owner === "pg_database_owner" &&
        defaults.length === 0 &&
        settings.length === 0 &&
        schemaAcl.length === 3 &&
        schemaAcl.every(
          (row) =>
            row.grantable === false &&
            ((row.name === "PUBLIC" && row.privilege === "USAGE") ||
              (row.name === "pg_database_owner" &&
                ["USAGE", "CREATE"].includes(String(row.privilege)))),
        )
      )
        return "absent";
      if (
        schema?.owner !== credentials.migrator.user ||
        settings.length !== 1 ||
        settings[0]?.name !== credentials.reader.user ||
        !Array.isArray(settings[0]?.settings) ||
        [...settings[0].settings].sort().join("|") !==
          [
            "default_transaction_read_only=on",
            "lock_timeout=1s",
            "statement_timeout=5s",
          ]
            .sort()
            .join("|")
      )
        return "review";
      if (
        schemaAcl.some(
          (row) =>
            row.name === "PUBLIC" ||
            ![
              credentials.migrator.user,
              credentials.runtime.user,
              credentials.reader.user,
            ].includes(String(row.name)) ||
            (row.name !== credentials.migrator.user &&
              (row.privilege !== "USAGE" || row.grantable !== false)),
        ) ||
        [credentials.runtime.user, credentials.reader.user].some(
          (name) =>
            !schemaAcl.some(
              (row) => row.name === name && row.privilege === "USAGE",
            ),
        )
      )
        return "review";
      const expected = [
        "r:runtime:SELECT",
        "r:runtime:INSERT",
        "r:runtime:UPDATE",
        "r:runtime:DELETE",
        "r:reader:SELECT",
        "S:runtime:USAGE",
        "S:runtime:SELECT",
        "S:reader:SELECT",
      ].sort();
      const actual: string[] = [];
      for (const row of defaults) {
        if (row.owner !== credentials.migrator.user || row.grantable !== false)
          return "review";
        if (row.grantee === credentials.migrator.user) continue;
        const role =
          row.grantee === credentials.runtime.user
            ? "runtime"
            : row.grantee === credentials.reader.user
              ? "reader"
              : "foreign";
        actual.push(`${row.object_type}:${role}:${row.privilege}`);
      }
      return actual.sort().join("|") === expected.join("|")
        ? "confirmed"
        : "review";
    });
  } catch {
    throw new Error(
      "Production setup phase inspection could not be verified. Saved resources remain protected.",
    );
  }
}

/** Recovery can confirm only initial empty schema setup; existing app objects are never adopted by this path. */
export async function inspectProductionProjectPhase(
  database: PostgresJsDatabase,
  identity: ProductionClusterIdentity,
  resourceId: string,
  credentials: unknown,
  phase: ProductionProvisionPhase,
): Promise<ProductionPhaseInspection> {
  return inspectProjectPolicy(
    database,
    identity,
    resourceId,
    credentials,
    phase,
    true,
  );
}
/** Verifies the same restricted role/grant policy after applications have legitimately created tables. */
export async function verifyProductionProjectPolicy(
  database: PostgresJsDatabase,
  identity: ProductionClusterIdentity,
  resourceId: string,
  credentials: unknown,
): Promise<void> {
  if (
    (await inspectProjectPolicy(
      database,
      identity,
      resourceId,
      credentials,
      "schema",
      false,
    )) !== "confirmed"
  )
    throw new Error("Production database role policy could not be verified.");
}
