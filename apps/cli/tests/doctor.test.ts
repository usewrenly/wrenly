import { expect, test } from "bun:test";
import { runCli } from "../src/index";
import type { Probes, Report } from "../src/contracts";
function probes(): Probes {
  return {
    platform: "linux",
    architecture: "x64",
    command: async (name, args) =>
      name === "flock"
        ? "flock from util-linux 2.40"
        : name === "bun"
          ? "1.3.14"
          : name === "node"
            ? "v24.1.0"
            : args[0] === "compose"
              ? "2.30.0"
              : args[0] === "--host"
                ? "linux"
                : "Docker version 29.1.3, build test",
    disk: async () => 20n * 1024n ** 3n,
    destination: async () => "absent",
    port: async () => true,
  };
}
test("plan reports all checks and never invokes install commands", async () => {
  const fixture = probes(),
    calls: string[] = [];
  const command = fixture.command;
  fixture.command = async (name, args) => {
    calls.push([name, ...args].join(" "));
    return command(name, args);
  };
  let output = "";
  expect(
    await runCli(
      ["plan", "--json", "--directory", "/tmp/new-wrenly"],
      (text) => (output += text),
      fixture,
    ),
  ).toBe(0);
  const report: Report = JSON.parse(output);
  expect(report.ready).toBe(true);
  expect(report.checks.length).toBe(12);
  expect(report.plan?.join(" ")).toContain("downloads nothing");
  expect(calls).toHaveLength(6);
  expect(
    calls.every(
      (value) => !value.includes(" up") && !value.includes("install"),
    ),
  ).toBe(true);
});
test("missing prerequisites and occupied ports fail without hiding other checks", async () => {
  const fixture = probes();
  fixture.command = async () => null;
  fixture.port = async () => false;
  fixture.destination = async () => "existing";
  let output = "";
  expect(
    await runCli(["doctor", "--json"], (text) => (output += text), fixture),
  ).toBe(1);
  const report: Report = JSON.parse(output);
  expect(report.ready).toBe(false);
  expect(
    report.checks.filter((c: { status: string }) => c.status === "unconfirmed"),
  ).toHaveLength(6);
  expect(report.checks.at(-1)?.status).toBe("failed");
});
test("help and invalid arguments do not probe", async () => {
  const fixture = probes();
  fixture.command = async () => {
    throw Error("must not run");
  };
  expect(await runCli(["help"], () => {}, fixture)).toBe(0);
  for (const args of [
    ["destroy"],
    ["doctor", "--directory", "relative"],
    ["doctor", "--web-port", "3002"],
    ["doctor", "--json", "--json"],
    ["doctor", "--unknown"],
    ["doctor", "--api-port", "99999"],
  ])
    expect(await runCli(args, () => {}, fixture)).toBe(2);
});
test("old tools, unsupported hosts and insufficient disk cannot be ready", async () => {
  const fixture = probes();
  fixture.platform = "darwin";
  fixture.architecture = "arm64";
  fixture.command = async () => "1.0.0";
  fixture.disk = async () => 1n;
  let output = "";
  expect(
    await runCli(["doctor", "--json"], (text) => (output += text), fixture),
  ).toBe(1);
  expect(JSON.parse(output).ready).toBe(false);
});
