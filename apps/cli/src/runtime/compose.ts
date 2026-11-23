/** Every lifecycle action is scoped to a generated Compose project and verified installation labels. */
import { z } from "zod";
import { join } from "node:path";
import { composeDocument } from "../install/prepare";
import { readPrivate, type State } from "../install/state";
import { runCommand, readCommand } from "./process";
export function composeProject(state: State): string {
  return "wrenly-" + state.id.replaceAll("-", "");
}
export async function composeArgs(state: State): Promise<string[]> {
  if (
    (await readPrivate(join(state.directory, ".wrenly", "compose.json"))) !==
    composeDocument(state)
  )
    throw new Error(
      "Installation composition changed; no Docker action was performed.",
    );
  await readPrivate(join(state.directory, ".env"));
  return [
    "docker",
    "--host",
    "unix:///var/run/docker.sock",
    "compose",
    "--project-name",
    composeProject(state),
    "--env-file",
    join(state.directory, ".env"),
    "--file",
    join(state.directory, ".wrenly", "compose.json"),
  ];
}
async function verifyVolume(state: State): Promise<void> {
  const name = `${composeProject(state)}_control-data`;
  const found = await readCommand(
    [
      "docker",
      "--host",
      "unix:///var/run/docker.sock",
      "volume",
      "ls",
      "--format",
      "{{.Name}}",
      "--filter",
      `name=^${name}$`,
    ],
    state.directory,
  );
  if (!found) return;
  if (found !== name) throw new Error("Unexpected database storage.");
  const raw = await readCommand(
    [
      "docker",
      "--host",
      "unix:///var/run/docker.sock",
      "volume",
      "inspect",
      name,
    ],
    state.directory,
  );
  const volumes = z
    .array(
      z.object({
        Name: z.literal(name),
        Driver: z.literal("local"),
        Options: z.record(z.string(), z.unknown()).nullable(),
        Labels: z.record(z.string(), z.string()),
      }),
    )
    .length(1)
    .parse(JSON.parse(raw));
  const volume = volumes[0]!;
  if (
    Object.keys(volume.Options ?? {}).length ||
    volume.Labels["io.wrenly.installation-id"] !== state.id ||
    volume.Labels["com.docker.compose.project"] !== composeProject(state)
  )
    throw new Error("Database volume ownership changed.");
}
/** A foreign project/name collision is never adopted, even if Compose would start it. */
export async function inspectDatabase(
  state: State,
): Promise<"absent" | "running" | "stopped"> {
  await verifyVolume(state);
  const project = composeProject(state);
  const ids = await readCommand(
    [
      "docker",
      "--host",
      "unix:///var/run/docker.sock",
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
    state.directory,
  );
  if (!ids) return "absent";
  if (!/^[a-f0-9]{12,64}$/.test(ids))
    throw new Error(
      "Unexpected installation containers; inspect before continuing.",
    );
  const reply = await readCommand(
    [
      "docker",
      "--host",
      "unix:///var/run/docker.sock",
      "inspect",
      "--format",
      '{{index .Config.Labels "io.wrenly.installation-id"}} {{index .Config.Labels "com.docker.compose.service"}} {{.State.Running}}',
      ids,
    ],
    state.directory,
  );
  if (
    reply !== `${state.id} postgres true` &&
    reply !== `${state.id} postgres false`
  )
    throw new Error("Database container ownership changed.");
  const configuration = JSON.parse(
    await readCommand(
      [
        "docker",
        "--host",
        "unix:///var/run/docker.sock",
        "inspect",
        "--format",
        "{{json .Mounts}}",
        ids,
      ],
      state.directory,
    ),
  ) as unknown;
  const mounts = z
    .array(
      z.object({
        Type: z.string(),
        Name: z.string().optional(),
        Destination: z.string(),
        RW: z.boolean(),
      }),
    )
    .parse(configuration);
  if (
    mounts.length !== 1 ||
    mounts[0]?.Type !== "volume" ||
    mounts[0]?.Name !== `${project}_control-data` ||
    mounts[0]?.Destination !== "/var/lib/postgresql/data" ||
    !mounts[0]?.RW
  )
    throw new Error("Database container storage changed.");
  return reply.endsWith("true") ? "running" : "stopped";
}
export async function startDatabase(state: State): Promise<void> {
  await inspectDatabase(state);
  await runCommand(
    [
      "flock",
      "--exclusive",
      "--nonblock",
      "--no-fork",
      join(state.directory, ".wrenly", "step.lock"),
      ...(await composeArgs(state)),
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "90",
      "postgres",
    ],
    state.directory,
    120000,
  );
  if ((await inspectDatabase(state)) !== "running")
    throw new Error("Database startup was not confirmed.");
}
export async function stopDatabase(state: State): Promise<void> {
  if ((await inspectDatabase(state)) === "absent") return;
  await runCommand(
    [
      "flock",
      "--exclusive",
      "--nonblock",
      "--no-fork",
      join(state.directory, ".wrenly", "step.lock"),
      ...(await composeArgs(state)),
      "stop",
      "--timeout",
      "30",
      "postgres",
    ],
    state.directory,
    45000,
  );
  if ((await inspectDatabase(state)) === "running")
    throw new Error("Database stop was not confirmed.");
}
