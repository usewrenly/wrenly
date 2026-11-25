import { expect, test } from "bun:test";
import type { State } from "../src/install/state";
import {
  renderInstallSummary,
  renderStatusReport,
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
