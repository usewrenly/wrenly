import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import type { Probes } from "../src/contracts";
import type { PromptIO } from "../src/prompts";
import { runInstallWizard } from "../src/wizard";

function createProbes(overrides: Partial<Probes> = {}): Probes {
  return {
    platform: "linux",
    architecture: "x64",
    command: async () => "ok",
    disk: async () => 20n * 1024n ** 3n,
    destination: async () => "absent",
    port: async () => true,
    ...overrides,
  };
}

function createFakeIo(): {
  io: PromptIO;
  input: PassThrough;
  getOutput: () => string;
} {
  const input = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  input.isTTY = true;
  input.setRawMode = () => {};
  let output = "";
  return {
    io: {
      input,
      output: {
        columns: 80,
        write: (text: string) => {
          output += text;
        },
      },
    },
    input,
    getOutput: () => output,
  };
}

function sendKeys(stream: PassThrough, sequence: string[]): void {
  queueMicrotask(async () => {
    for (const key of sequence) {
      stream.write(key);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  });
}

test("Recommended preset returns expanded args with previews, laravel, databases, inspection and --yes", async () => {
  const fake = createFakeIo();
  const promise = runInstallWizard(
    [],
    fake.io,
    createProbes(),
    false,
    "/home/tester/wrenly",
    "/home/tester",
  );
  // Folder Enter -> Preset Recommended Enter -> Default ports Yes Enter -> Confirm install Enter
  sendKeys(fake.input, ["\r", "\r", "\r", "\r"]);
  const result = await promise;
  expect(result).toContain("install");
  expect(result).toContain("--directory");
  expect(result).toContain("/home/tester/wrenly");
  expect(result).toContain("--previews");
  expect(result).toContain("--laravel");
  expect(result).toContain("--databases");
  expect(result).toContain("--inspection");
  expect(result).toContain("--yes");
  expect(result).not.toContain("--dictation");
  expect(fake.getOutput()).toContain("Next.js 16 + Laravel 13");
  expect(fake.getOutput()).toContain(
    "Equivalent command: bunx @wrenly/cli install --directory /home/tester/wrenly --preset recommended",
  );
});

test("Custom setup selecting only databases implies --previews and notes it", async () => {
  const fake = createFakeIo();
  const promise = runInstallWizard(
    ["install"],
    fake.io,
    createProbes(),
    false,
    "/home/tester/wrenly",
    "/home/tester",
  );
  // Folder Enter -> Select Custom (3 downs + Enter) -> Multiselect 3rd item (2 downs + space + Enter) -> Ports Enter -> Proceed Enter
  sendKeys(fake.input, [
    "\r",
    "\u001b[B",
    "\u001b[B",
    "\u001b[B",
    "\r",
    "\u001b[B",
    "\u001b[B",
    " ",
    "\r",
    "\r",
    "\r",
  ]);
  const result = await promise;
  expect(result).toContain("--databases");
  expect(result).toContain("--previews");
  expect(result).not.toContain("--laravel");
  expect(fake.getOutput()).toContain(
    "Also enabled: Local previews (required by Development app databases)",
  );
});

test("busy port 3000 suggests 3001 as initial replacement value", async () => {
  const fake = createFakeIo();
  const promise = runInstallWizard(
    ["install"],
    fake.io,
    createProbes({
      port: async (port) => port !== 3000,
    }),
    false,
    "/home/tester/wrenly",
    "/home/tester",
  );
  // Folder Enter -> Recommended Enter -> accept suggested 3001 Enter -> Confirm install Enter
  sendKeys(fake.input, ["\r", "\r", "\r", "\r"]);
  const result = await promise;
  expect(fake.getOutput()).toContain("Port 3000 is in use");
  const webIdx = result.indexOf("--web-port");
  expect(webIdx).toBeGreaterThan(-1);
  expect(result[webIdx + 1]).toBe("3001");
});

test("explicit --directory and --preset flags skip their prompts", async () => {
  const fake = createFakeIo();
  const promise = runInstallWizard(
    [
      "install",
      "--directory",
      "/tmp/wrenly-explicit",
      "--preset",
      "recommended",
    ],
    fake.io,
    createProbes(),
    false,
    "/home/tester/wrenly",
    "/home/tester",
  );
  // Only default ports prompt + final proceed prompt should run
  sendKeys(fake.input, ["\r", "\r"]);
  const result = await promise;
  expect(result).toContain("/tmp/wrenly-explicit");
  expect(result).toContain("--previews");
  expect(fake.getOutput()).not.toContain("Installation folder");
  expect(fake.getOutput()).not.toContain("Setup profile");
});

test("existing destination folder triggers validation error and re-asks", async () => {
  const fake = createFakeIo();
  const promise = runInstallWizard(
    [],
    fake.io,
    createProbes({
      destination: async (dir) =>
        dir === "/home/tester/taken" ? "existing" : "absent",
    }),
    false,
    "/home/tester/taken",
    homedir(),
  );
  // Enter on taken -> backspace x5 ("taken") -> type "fresh" -> Enter -> Recommended -> Ports -> Confirm
  sendKeys(fake.input, [
    "\r",
    "\u007f",
    "\u007f",
    "\u007f",
    "\u007f",
    "\u007f",
    "f",
    "r",
    "e",
    "s",
    "h",
    "\r",
    "\r",
    "\r",
    "\r",
  ]);
  const result = await promise;
  expect(fake.getOutput()).toContain("That folder already exists");
  expect(result).toContain("/home/tester/fresh");
});

test("suggests cwd/wrenly outside homedir and resolves typed relative subfolder", async () => {
  const fake1 = createFakeIo();
  const p1 = runInstallWizard(
    [],
    fake1.io,
    createProbes(),
    false,
    "/home/tester/wrenly",
    "/tmp/e2e/v5",
  );
  sendKeys(fake1.input, ["\r", "\r", "\r", "\r"]);
  const r1 = await p1;
  expect(r1).toContain("/tmp/e2e/v5/wrenly");

  const fake2 = createFakeIo();
  const p2 = runInstallWizard(
    [],
    fake2.io,
    createProbes(),
    false,
    "/home/tester/wrenly",
    "/tmp/e2e/v5",
  );
  sendKeys(fake2.input, ["custom-app", "\r", "\r", "\r", "\r"]);
  const r2 = await p2;
  expect(r2).toContain("/tmp/e2e/v5/custom-app");
});
