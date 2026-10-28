/**
 * Shared provider destination policy facade.
 * Reuses the inference package’s resolved-address and network-scope validation so configuration probes and real inference enforce one authoritative policy.
 * Does not implement a second DNS/SSRF rule set.
 */
export {
  resolveProviderDestination,
  isAllowedProviderAddress,
  ProviderDestinationError,
  type ProviderLookup,
} from "@wrenly/inference";
