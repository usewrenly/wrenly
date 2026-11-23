/** Reject unsafe destinations before a Production adapter receives connection credentials. */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { ProductionDatabaseTarget } from "@wrenly/db/production-database-target-contract";
const MAX_ADDRESSES = 16;
const RESOLUTION_TIMEOUT_MS = 5_000;
const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
export class ProductionDestinationError extends Error {
  constructor() {
    super(
      "The private Production database destination could not be verified. Use a separate private target with verified TLS.",
    );
    this.name = "ProductionDestinationError";
  }
}
export interface PinnedProductionTarget {
  target: ProductionDatabaseTarget;
  addresses: string[];
}
export type DatabaseAddressLookup = (
  host: string,
) => Promise<Array<{ address: string; family: number }>>;
/** Canonical forms prevent equivalent IPv6 spellings from escaping control-cluster comparison. */
function address(value: string): string {
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6 || value.includes("%"))
    throw new ProductionDestinationError();
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // Mapped addresses are unnecessary for a private database and complicate endpoint identity.
  if (normalized.startsWith("::ffff:")) throw new ProductionDestinationError();
  return normalized;
}
function privateAddress(value: string): boolean {
  return PRIVATE.check(value, isIP(value) === 4 ? "ipv4" : "ipv6");
}
async function resolveAddresses(
  host: string,
  resolver: DatabaseAddressLookup,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();
  const values = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolver(host);
  signal.throwIfAborted();
  if (!values.length || values.length > MAX_ADDRESSES)
    throw new ProductionDestinationError();
  for (const value of values)
    if (isIP(value.address) !== value.family)
      throw new ProductionDestinationError();
  return [...new Set(values.map((value) => address(value.address)))].sort();
}
/** Resolve all answers, isolate the control cluster and pin the full set; this does not establish TLS or SQL readiness. */
export async function pinProductionDatabaseTarget(
  raw: unknown,
  controlDatabaseUrl: string,
  options: { lookup?: DatabaseAddressLookup; signal?: AbortSignal } = {},
): Promise<PinnedProductionTarget> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  let onAbort: (() => void) | undefined;
  try {
    const target = ProductionDatabaseTarget.parse(raw);
    const control = new URL(controlDatabaseUrl);
    if (!["postgres:", "postgresql:"].includes(control.protocol))
      throw new ProductionDestinationError();
    const controlHost = control.hostname.replace(/^\[|\]$/g, "");
    if (!controlHost) throw new ProductionDestinationError();
    const resolver: DatabaseAddressLookup =
      options.lookup ?? ((host) => lookup(host, { all: true, verbatim: true }));
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ProductionDestinationError());
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    const [destinations, controlAddresses] = await Promise.race([
      Promise.all([
        resolveAddresses(target.host, resolver, signal),
        resolveAddresses(controlHost, resolver, signal),
      ]),
      cancelled,
    ]);
    if (
      target.host === controlHost.toLowerCase() ||
      destinations.some(
        (value) => !privateAddress(value) || controlAddresses.includes(value),
      )
    )
      throw new ProductionDestinationError();
    return { target, addresses: destinations };
  } catch {
    throw new ProductionDestinationError();
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
/** Revalidation never silently chooses a new address after DNS changes. No socket is opened here. */
export async function recheckProductionDatabaseTarget(
  saved: PinnedProductionTarget,
  controlDatabaseUrl: string,
  options: { lookup?: DatabaseAddressLookup; signal?: AbortSignal } = {},
): Promise<PinnedProductionTarget> {
  const current = await pinProductionDatabaseTarget(
    saved.target,
    controlDatabaseUrl,
    options,
  );
  if (JSON.stringify(current.addresses) !== JSON.stringify(saved.addresses))
    throw new ProductionDestinationError();
  return current;
}
