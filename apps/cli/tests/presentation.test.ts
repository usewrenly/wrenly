import { expect, test } from "bun:test";
import type { Options, Report } from "../src/contracts";
import { CLI_VERSION } from "../src/install/release";
import type { State } from "../src/install/state";
import {
  renderActionResult,
  renderBrandHeader,
  renderDoctorTable,
  renderHelp,
  renderInstallSummary,
  renderOwnerSetupLink,
  renderPlanTable,
  renderStatusReport,
  renderWizardSummary,
  stripAnsi,
} from "../src/presentation";

function sampleState(overrides: Partial<State> = {}): State {
  return {
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    directory: "/home/tester/wrenly",
    revision: "a".repeat(40),
    sha256: "b".repeat(64),
    webPort: 3000,
    apiPort: 3002,
    databasePort: 65433,
    previewPort: 3003,
    previews: true,
    laravel: true,
    databases: true,
    inspection: true,
    dictation: false,
    phase: "ready",
    steps: {},
    ...overrides,
  };
}

test("plain renderInstallSummary emits every required row without ANSI escapes or setup tokens", () => {
  const plain = renderInstallSummary(sampleState(), false);
  expect(plain).toBe(stripAnsi(plain));
  expect(plain).toContain("http://localhost:3000");
  expect(plain).toContain("/home/tester/wrenly");
  expect(plain).toContain("/home/tester/wrenly/.env (private, back it up)");
  expect(plain).toContain("✔ Local previews");
  expect(plain).toContain("✔ Laravel 13 toolchain");
  expect(plain).toContain("✔ Development app databases");
  expect(plain).toContain("✔ Official framework inspection");
  expect(plain).toContain(
    "○ Local voice dictation (new install with --dictation)",
  );
  expect(plain).toContain("1. Create your owner account (private link below)");
  expect(plain).toContain("2. Settings → Providers → connect a model");
  expect(plain).toContain("3. Describe your first app");
  expect(plain).toContain(
    "bunx @wrenly/cli status|stop|start --directory /home/tester/wrenly",
  );
  expect(plain).toContain("usewrenly.org/docs/guides/publishing-setup");
  expect(plain).toContain("https://www.usewrenly.org/#join");
  expect(plain).not.toContain("#setup=");
});

test("decorated renderInstallSummary renders rounded box without setup tokens", () => {
  const decorated = renderInstallSummary(sampleState(), true, 80);
  expect(decorated).toContain("╭─ Wrenly is ready");
  expect(decorated).toContain("╰");
  expect(decorated).not.toContain("#setup=");
  expect(stripAnsi(decorated)).toContain("http://localhost:3000");
});

test("renderStatusReport formats plain and decorated output with expected fields", () => {
  const status = {
    id: "11111111-1111-4111-8111-111111111111",
    phase: "ready",
    database: "running",
    url: "http://localhost:3000",
    runtime: { status: "running" },
  };
  const plain = renderStatusReport(status, false);
  expect(plain).toBe(stripAnsi(plain));
  expect(plain).toContain("Runtime: running");
  const card = renderStatusReport(status, true, 80);
  expect(card).toContain("╭─ Wrenly status");
  expect(stripAnsi(card)).toContain("http://localhost:3000");
});

test("renderBrandHeader draws line-art bird without block fills and shows version", () => {
  const decorated = renderBrandHeader("guided setup", true);
  const plainHeader = stripAnsi(decorated);
  expect(plainHeader).toContain(`wrenly  v${CLI_VERSION}`);
  expect(plainHeader).toContain("guided setup");
  expect(plainHeader).toContain("⢸⢳⡀⣠⠎⡇");
  expect(plainHeader).toContain("⡧⠤⣄⣀");
  expect(plainHeader).toContain("⡯⠖⠋");
  expect(plainHeader).not.toMatch(/[█▓▒░]/);

  const nonDecorated = renderBrandHeader("guided setup", false);
  expect(nonDecorated).toBe(stripAnsi(nonDecorated));
  expect(nonDecorated).toBe(`wrenly v${CLI_VERSION} · guided setup\n\n`);
});

test("renderDoctorTable formats rounded table with pass/fail badges, remedies and plain fallback", () => {
  const report: Report = {
    version: 1,
    command: "doctor",
    ready: false,
    checks: [
      { name: "Host", status: "pass", message: "Linux x86_64 supported." },
      {
        name: "Docker",
        status: "failed",
        message: "Daemon unavailable.",
        remedy: "Start Docker.",
      },
    ],
  };

  const decorated = renderDoctorTable(report, true, 80);
  const visible = stripAnsi(decorated);
  expect(visible).toContain("╭─");
  expect(visible).toContain("╰─");
  expect(visible).toContain("✔ Pass");
  expect(visible).toContain("✘ Fail");
  expect(visible).toContain("Docker: Start Docker.");

  const plain = renderDoctorTable(report, false, 80);
  expect(plain).toBe(stripAnsi(plain));
  expect(plain).toContain("PASS");
  expect(plain).toContain("FAILED");
  expect(plain).toContain("Docker: Start Docker.");
});

test("renderPlanTable shows Next.js 16 and Laravel 13 and emits dry-run footer only when requested", () => {
  const options: Options = {
    command: "plan",
    directory: "/tmp/wrenly-app",
    webPort: 3000,
    apiPort: 3002,
    json: false,
    yes: false,
    databasePort: 65433,
    previewPort: 3003,
    previews: true,
    laravel: true,
    databases: true,
    inspection: true,
    dictation: false,
  };

  const dryRunOut = stripAnsi(renderPlanTable(options, true, 80, true));
  expect(dryRunOut).toContain("Next.js 16");
  expect(dryRunOut).toContain("Laravel 13");
  expect(dryRunOut).toContain("Dry run only — nothing was downloaded or changed");

  const installOut = stripAnsi(renderPlanTable(options, true, 80, false));
  expect(installOut).toContain("Next.js 16");
  expect(installOut).not.toContain("Dry run only");
});

test("renderWizardSummary keeps equivalent command outside rounded table borders", () => {
  const cmd = "bunx @wrenly/cli install --directory /tmp/app --preset recommended";
  const output = renderWizardSummary(
    {
      directory: "/tmp/app",
      frameworks: "Next.js 16 + Laravel 13",
      capabilities: "Local previews, Laravel 13 toolchain",
      ports: "web 3000 · api 3002 · db 65433 · preview 3003",
      equivalentCommand: cmd,
    },
    true,
    80,
  );
  const visible = stripAnsi(output);
  expect(visible).toContain("Setting");
  expect(visible).toContain("Next.js 16 + Laravel 13");
  const lastLine = visible.trim().split("\n").at(-1);
  expect(lastLine?.trim()).toBe(cmd);
});

test("renderHelp includes version, brand header, lifecycle note, and updates link", () => {
  const plain = renderHelp(false);
  expect(plain).toBe(stripAnsi(plain));
  expect(plain).toContain(`wrenly v${CLI_VERSION}`);
  expect(plain).toContain("guided local setup");
  expect(plain).toContain("does not upgrade or uninstall");
  expect(plain).toContain("https://www.usewrenly.org/#join");

  const decorated = stripAnsi(renderHelp(true));
  expect(decorated).toContain(`wrenly  v${CLI_VERSION}`);
  expect(decorated).toContain("guided local setup");
  expect(decorated).toContain("does not upgrade or uninstall");
  expect(decorated).toContain("https://www.usewrenly.org/#join");
});

test("owner setup and action formatters render a single cohesive block without auto-open notes", () => {
  const sampleUrl = "http://localhost:3000/setup#setup=example-token";
  const blockDecorated = renderOwnerSetupLink(sampleUrl, "/tmp/my app", true);
  const visible = stripAnsi(blockDecorated);
  expect(visible).toContain("◆  Owner account setup");
  expect(visible).toContain(`│  ${sampleUrl}`);
  expect(visible).toContain("One-time use · expires in 10 minutes");
  expect(visible).toContain(
    '└  Need a fresh link later? Run: bunx @wrenly/cli setup --directory "/tmp/my app"',
  );
  expect(visible).not.toContain("Browser auto-open");

  const blockPlain = renderOwnerSetupLink(sampleUrl, "/tmp/my-app", false);
  expect(blockPlain).toBe(stripAnsi(blockPlain));
  expect(blockPlain).toContain(sampleUrl);
  expect(blockPlain).toContain(
    "Need a fresh link later? Run: bunx @wrenly/cli setup --directory /tmp/my-app",
  );
  expect(blockPlain).not.toContain("Browser auto-open");

  const actionDecorated = renderActionResult("Stopped.", true);
  expect(stripAnsi(actionDecorated)).toContain("✔  Stopped.");
  expect(renderActionResult("Stopped.", false)).toBe("Stopped.\n");
});
