/** Infrastructure contracts contain no framework tools, browser routes or provider credentials. */
export interface DatabaseProviderIntent {
  resourceId: string;
  operationId: string;
  /** Frozen non-secret placement; the selected adapter validates its own provider fields. */
  placement: Readonly<Record<string, string>>;
}
export interface DatabaseSetupCredential { user: string; password: string }
export interface DatabaseProviderResource {
  remoteId: string;
  state: string;
  /** Provider configuration only; callers must still verify the live TLS connection. */
  tlsConfigured: boolean;
}
export interface DatabaseProvider {
  readonly id: string;
  createStopped: (intent: DatabaseProviderIntent, credential: DatabaseSetupCredential, signal: AbortSignal) => Promise<string>;
  inspect: (intent: DatabaseProviderIntent, remoteId: string, signal: AbortSignal) => Promise<DatabaseProviderResource>;
  find: (intent: DatabaseProviderIntent, signal: AbortSignal) => Promise<DatabaseProviderResource | null>;
}
/** Only compiled-in adapters are eligible. Missing or duplicate identities never fall back to another provider. */
export function resolveDatabaseProvider(providers: readonly DatabaseProvider[], id: string): DatabaseProvider {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error("Invalid database provider selection.");
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider.id) || seen.has(provider.id)) throw new Error("Database provider registry is ambiguous.");
    seen.add(provider.id);
  }
  const selected = providers.find(provider => provider.id === id);
  if (!selected) throw new Error("The saved database provider is unavailable. Restore its configuration before continuing.");
  return selected;
}
