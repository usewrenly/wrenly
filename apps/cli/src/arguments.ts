/** Parse only the released read-only commands; installation is a later explicit action. */
import { isAbsolute, normalize } from "node:path";
import type { Options } from "./contracts";
const MAX_PATH_LENGTH = 4096;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
export function parseArguments(
  args: string[],
  defaultDirectory: string,
): Options {
  const first = args[0] ?? "help";
  const command = first === "--help" || first === "-h" ? "help" : first;
  if (!["doctor", "plan", "help"].includes(command))
    throw new Error(
      "Use doctor, plan or help. Installation is not available in this candidate yet.",
    );
  const result: Options = {
    command: command as Options["command"],
    directory: defaultDirectory,
    webPort: 3000,
    apiPort: 3002,
    json: false,
  };
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === "--json") {
      result.json = true;
      continue;
    }
    if (!["--directory", "--web-port", "--api-port"].includes(flag))
      throw new Error("Unknown option. Use help for supported options.");
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}.`);
    if (flag === "--directory") {
      if (
        !isAbsolute(value) ||
        value.length > MAX_PATH_LENGTH ||
        [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        throw new Error(
          "Choose an absolute directory without control characters.",
        );
      result.directory = normalize(value);
    } else {
      const port = Number(value);
      if (
        !/^\d+$/.test(value) ||
        !Number.isInteger(port) ||
        port < MIN_PORT ||
        port > MAX_PORT
      )
        throw new Error("Choose a port between 1024 and 65535.");
      if (flag === "--web-port") result.webPort = port;
      else result.apiPort = port;
    }
  }
  if (result.webPort === result.apiPort)
    throw new Error("Web and API need different ports.");
  return result;
}
