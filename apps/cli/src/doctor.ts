/** Explain each prerequisite independently, so one missing tool cannot hide another problem. */
import type { Check, Options, Probes, Report } from "./contracts";
const MIN_DISK_BYTES = 10n * 1024n * 1024n * 1024n;
function version(output: string | null): number[] | null {
  const match = output?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function atLeast(actual: number[], minimum: number[]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    if (actual[i] !== minimum[i]) return actual[i]! > minimum[i]!;
  }
  return true;
}
function result(
  name: string,
  value: boolean | null,
  message: string,
  remedy: string,
): Check {
  return {
    name,
    status: value === null ? "unconfirmed" : value ? "pass" : "failed",
    message,
    ...(value ? {} : { remedy }),
  };
}
/** Probe adapters make failures testable without installing tools or touching real services. */
export async function inspectInstallation(
  options: Options,
  probes: Probes,
): Promise<Report> {
  const checks: Check[] = [];
  checks.push(
    result(
      "Host",
      probes.platform === "linux" && probes.architecture === "x64",
      "Linux x86_64 is the first supported installer target.",
      "Use a supported Linux x86_64 host; other platforms are not verified yet.",
    ),
  );
  const commands: Array<
    [
      string,
      "bun" | "node" | "docker",
      string[],
      (value: string) => boolean,
      string,
    ]
  > = [
    [
      "Bun",
      "bun",
      ["--version"],
      (v) => {
        const parsed = version(v);
        return Boolean(parsed && atLeast(parsed, [1, 3, 14]));
      },
      "Install Bun 1.3.14 or newer.",
    ],
    [
      "Node",
      "node",
      ["--version"],
      (v) => {
        const parsed = version(v);
        return Boolean(parsed && atLeast(parsed, [24, 0, 0]));
      },
      "Install Node 24 or newer for the web build.",
    ],
    [
      "Docker CLI",
      "docker",
      ["--version"],
      (v) => /^Docker version \d+\./.test(v),
      "Install Docker Engine and its CLI.",
    ],
    [
      "Docker Compose",
      "docker",
      ["compose", "version", "--short"],
      (v) => {
        const parsed = version(v);
        return Boolean(parsed && atLeast(parsed, [2, 0, 0]));
      },
      "Install the Docker Compose plugin (v2 or newer).",
    ],
    [
      "Docker daemon",
      "docker",
      [
        "--host",
        "unix:///var/run/docker.sock",
        "info",
        "--format",
        "{{.OSType}}",
      ],
      (v) => v.trim() === "linux",
      "Start local Docker and grant your account access; this command never changes permissions.",
    ],
  ];
  for (const [name, command, args, accept, remedy] of commands) {
    const output = await probes.command(command, args);
    checks.push(
      result(
        name,
        output === null ? null : accept(output),
        output === null
          ? "Could not confirm this prerequisite."
          : accept(output)
            ? "Available."
            : "The installed tool does not meet this prerequisite.",
        remedy,
      ),
    );
  }
  const disk = await probes.disk(options.directory);
  checks.push(
    result(
      "Disk",
      disk === null ? null : disk >= MIN_DISK_BYTES,
      disk === null
        ? "Free disk space could not be confirmed."
        : `${(Number(disk) / 1024 ** 3).toFixed(1)} GiB free; at least 10 GiB is required for the initial source installation.`,
      "Choose a disk with at least 10 GiB free; Docker images and generated projects need additional space.",
    ),
  );
  const destination = await probes.destination(options.directory);
  checks.push(
    result(
      "Destination",
      destination === "unconfirmed" ? null : destination === "absent",
      destination === "absent"
        ? "The destination does not exist yet."
        : "The destination already exists or cannot be safely confirmed.",
      "Choose a new directory. Existing installations require explicit inspection; nothing will be overwritten.",
    ),
  );
  for (const [name, port] of [
    ["Web port", options.webPort],
    ["API port", options.apiPort],
  ] as const) {
    const available = await probes.port(port);
    checks.push(
      result(
        name,
        available,
        `Loopback port ${port} ${available === true ? "is available" : available === false ? "is occupied" : "could not be checked"}.`,
        "Choose another port with --web-port or --api-port; no other service will be stopped.",
      ),
    );
  }
  const report: Report = {
    version: 1,
    command: options.command === "plan" ? "plan" : "doctor",
    ready: checks.every((check) => check.status === "pass"),
    checks,
  };
  if (options.command === "plan")
    report.plan = [
      `Destination: ${options.directory}`,
      `Browser: http://localhost:${options.webPort}; API: http://localhost:${options.apiPort}`,
      "Future installation will verify a pinned release, prepare private configuration, start dedicated services and apply checked-in migrations.",
      "First-owner credentials will be chosen in protected browser setup.",
      "This candidate only checks and plans. It downloads nothing, writes no configuration and starts no services.",
    ];
  return report;
}
