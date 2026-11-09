/** Safe browser projection of a personal source connection; no credential fields are allowed. */
export interface SourceConnectionStatus {
  canRegister: boolean;
  app: { slug: string } | null;
  connection: {
    id: string;
    version: string;
    login: string;
    needsAuthorization: boolean;
  } | null;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
/** Fail closed on unreadable metadata rather than presenting a connection as absent. */
export function parseSourceConnectionStatus(
  raw: unknown,
): SourceConnectionStatus {
  if (!record(raw) || typeof raw.canRegister !== "boolean")
    throw new Error("Connection status could not be read.");
  let app: SourceConnectionStatus["app"] = null,
    connection: SourceConnectionStatus["connection"] = null;
  if (raw.app !== null) {
    if (
      !record(raw.app) ||
      typeof raw.app.slug !== "string" ||
      !/^[A-Za-z0-9-]{1,100}$/.test(raw.app.slug)
    )
      throw new Error("Connection status could not be read.");
    app = { slug: raw.app.slug };
  }
  if (raw.connection !== null) {
    const value = raw.connection;
    if (
      !record(value) ||
      !["id", "version"].every(
        (key) =>
          typeof value[key] === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            value[key] as string,
          ),
      ) ||
      typeof value.login !== "string" ||
      !/^[A-Za-z0-9-]{1,100}$/.test(value.login) ||
      typeof value.needsAuthorization !== "boolean"
    )
      throw new Error("Connection status could not be read.");
    connection = {
      id: String(value.id),
      version: String(value.version),
      login: value.login,
      needsAuthorization: value.needsAuthorization,
    };
  }
  return { canRegister: raw.canRegister, app, connection };
}
