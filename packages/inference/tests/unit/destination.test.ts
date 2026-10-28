import { expect, test } from "bun:test";
import {
  isAllowedProviderAddress,
  resolveProviderDestination,
} from "../../src/network/destination";
test("provider destinations separate public cloud from explicit local and refuse metadata, reserved and mapped private addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "100.64.1.2",
    "::1",
    "fd00::1",
    "::ffff:127.0.0.1",
  ]) {
    expect(isAllowedProviderAddress(address, "local")).toBe(true);
    expect(isAllowedProviderAddress(address, "cloud")).toBe(false);
  }
  for (const address of [
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "192.0.2.1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "::",
    "::ffff:a9fe:a9fe",
  ]) {
    expect(isAllowedProviderAddress(address, "cloud")).toBe(false);
    expect(isAllowedProviderAddress(address, "local")).toBe(false);
  }
  for (const address of ["8.8.8.8", "2606:4700:4700::1111"]) {
    expect(isAllowedProviderAddress(address, "cloud")).toBe(true);
    expect(isAllowedProviderAddress(address, "local")).toBe(false);
  }
});
test("DNS answers are bounded and all validated before choosing a pinned destination", async () => {
  const result = await resolveProviderDestination(
    "https://provider.example/v1",
    "cloud",
    async () => [{ address: "8.8.8.8", family: 4 }],
  );
  expect(result.address).toBe("8.8.8.8");
  expect(result.url.hostname).toBe("provider.example");
  await expect(
    resolveProviderDestination(
      "https://provider.example/v1",
      "cloud",
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    ),
  ).rejects.toThrow("outside");
  await expect(
    resolveProviderDestination("http://provider.example/v1", "cloud"),
  ).rejects.toThrow("HTTPS");
  await expect(
    resolveProviderDestination(
      "https://user:secret@provider.example/v1",
      "cloud",
    ),
  ).rejects.toThrow("credential-free");
  await expect(
    resolveProviderDestination("http://metadata.google.internal", "local"),
  ).rejects.toThrow("not an allowed");
  await expect(
    resolveProviderDestination(
      "http://localhost:11434",
      "local",
      async () => [],
    ),
  ).rejects.toThrow("outside");
});

test("invalid runtime network scopes fail before DNS instead of assuming cloud policy", async () => {
  let lookups = 0;
  const resolver = async (): Promise<
    Array<{ address: string; family: number }>
  > => {
    lookups++;
    return [{ address: "8.8.8.8", family: 4 }];
  };
  const allowed: unknown = Reflect.apply(isAllowedProviderAddress, undefined, [
    "8.8.8.8",
    "unexpected",
  ]);
  expect(allowed).toBe(false);
  await expect(
    Reflect.apply(resolveProviderDestination, undefined, [
      "http://provider.example",
      "unexpected",
      resolver,
    ]),
  ).rejects.toThrow("explicit local or cloud");
  expect(lookups).toBe(0);
});
