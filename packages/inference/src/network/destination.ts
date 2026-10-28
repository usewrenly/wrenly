/**
 * Provider destination policy shared by API probes and inference.
 * Separates explicit local services from public HTTPS cloud services, rejects metadata/reserved addresses and validates every DNS answer.
 * Callers must pin the returned address while retaining hostname/TLS identity.
 */
import { isIP, BlockList } from "node:net";
import { lookup } from "node:dns/promises";
// Bound validation work and reject mixed allowed/forbidden answers rather than choosing around them.
const MAX_ADDRESSES = 16;
const RESOLUTION_TIMEOUT_MS = 5000;
// Cloud credentials must never reach private, metadata, documentation or multicast networks.
const CLOUD_BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  CLOUD_BLOCKED.addSubnet(network, prefix, "ipv4");
// Local inference is explicit; link-local metadata ranges are deliberately absent.
const LOCAL_ALLOWED = new BlockList();
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const)
  LOCAL_ALLOWED.addSubnet(network, prefix, "ipv4");
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  BLOCKED_V6.addSubnet(network, prefix, "ipv6");
const LOCAL_V6 = new BlockList();
LOCAL_V6.addAddress("::1", "ipv6");
LOCAL_V6.addSubnet("fc00::", 7, "ipv6");
export class ProviderDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderDestinationError";
  }
}
function mappedIpv4(address: string): string | null {
  if (!address.toLowerCase().startsWith("::ffff:")) return null;
  const suffix = address.slice(7);
  if (isIP(suffix) === 4) return suffix;
  const words = suffix.split(":");
  if (
    words.length !== 2 ||
    !words.every((word) => /^[a-f0-9]{1,4}$/i.test(word))
  )
    return null;
  const high = parseInt(words[0]!, 16),
    low = parseInt(words[1]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}
/** Determines whether a resolved address is public cloud or explicitly local; metadata/link-local targets are never allowed. */
export function isAllowedProviderAddress(
  address: string,
  kind: "local" | "cloud",
): boolean {
  try {
    if (kind !== "local" && kind !== "cloud") return false;
    let normalized = address;
    if (isIP(address) === 6)
      normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mapped = mappedIpv4(normalized);
    if (mapped) normalized = mapped;
    const family = isIP(normalized);
    if (family === 4)
      return kind === "local"
        ? LOCAL_ALLOWED.check(normalized, "ipv4")
        : !CLOUD_BLOCKED.check(normalized, "ipv4");
    if (family === 6)
      return kind === "local"
        ? LOCAL_V6.check(normalized, "ipv6")
        : GLOBAL_V6.check(normalized, "ipv6") &&
            !BLOCKED_V6.check(normalized, "ipv6");
    return false;
  } catch {
    return false;
  }
}
export type ProviderLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;
/** Resolves and validates all DNS answers before any credential-bearing request can be created. Caller must pin the selected address. */
export async function resolveProviderDestination(
  endpoint: string,
  kind: "local" | "cloud",
  resolver: ProviderLookup = (hostname) =>
    lookup(hostname, { all: true, verbatim: true }),
  signal?: AbortSignal,
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    if (kind !== "local" && kind !== "cloud")
      throw new ProviderDestinationError(
        "Choose an explicit local or cloud provider network scope.",
      );
    const url = new URL(endpoint);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      (kind === "cloud" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new ProviderDestinationError(
        "Use a credential-free provider address; hosted providers require HTTPS.",
      );
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      hostname === "metadata.google.internal" ||
      hostname.endsWith(".metadata.google.internal") ||
      hostname.includes("%")
    )
      throw new ProviderDestinationError(
        "This address is not an allowed model provider destination.",
      );
    const literal = isIP(hostname);
    const addresses = literal
      ? [{ address: hostname, family: literal }]
      : await Promise.race([
          resolver(hostname),
          new Promise<never>((_resolve, reject) => {
            // Native DNS may continue internally, but cancellation must stop the caller
            // waiting or creating a credential-bearing request from a late answer.
            abort = () =>
              reject(
                new ProviderDestinationError(
                  "Provider address lookup was cancelled.",
                ),
              );
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            timer = setTimeout(
              () =>
                reject(
                  new ProviderDestinationError(
                    "Provider address lookup timed out.",
                  ),
                ),
              RESOLUTION_TIMEOUT_MS,
            );
          }),
        ]);
    if (
      !addresses.length ||
      addresses.length > MAX_ADDRESSES ||
      addresses.some(
        (entry) =>
          ![4, 6].includes(entry.family) ||
          isIP(entry.address) !== entry.family ||
          !isAllowedProviderAddress(entry.address, kind),
      )
    )
      throw new ProviderDestinationError(
        "The provider address resolves outside its allowed local or hosted network scope.",
      );
    const selected = addresses[0]!;
    return { url, address: selected.address, family: selected.family as 4 | 6 };
  } catch (error) {
    if (error instanceof ProviderDestinationError) throw error;
    throw new ProviderDestinationError(
      "The provider address could not be validated. Check its host and network scope.",
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
