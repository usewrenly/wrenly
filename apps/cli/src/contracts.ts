/** Shared CLI-only result shapes; reports never contain environment values or file contents. */
export interface Options {
  command: "doctor" | "plan" | "help";
  directory: string;
  webPort: number;
  apiPort: number;
  json: boolean;
}
export interface Check {
  name: string;
  status: "pass" | "failed" | "unconfirmed";
  message: string;
  remedy?: string;
}
export interface Report {
  version: 1;
  command: "doctor" | "plan";
  ready: boolean;
  checks: Check[];
  plan?: string[];
}
export interface Probes {
  platform: string;
  architecture: string;
  command(
    name: "bun" | "node" | "docker",
    args: string[],
  ): Promise<string | null>;
  disk(directory: string): Promise<bigint | null>;
  destination(
    directory: string,
  ): Promise<"absent" | "existing" | "unsafe" | "unconfirmed">;
  port(port: number): Promise<boolean | null>;
}
