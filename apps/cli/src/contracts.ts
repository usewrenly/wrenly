/** Shared CLI-only result shapes; reports never contain environment values or file contents. */
export type InstallPreset = "minimal" | "recommended" | "full";
export interface Options {
  command:
    | "doctor"
    | "plan"
    | "help"
    | "version"
    | "install"
    | "resume"
    | "status"
    | "start"
    | "stop"
    | "setup";
  directory: string;
  webPort: number;
  apiPort: number;
  json: boolean;
  yes: boolean;
  archive?: string;
  databasePort: number;
  previewPort: number;
  previews: boolean;
  laravel: boolean;
  databases: boolean;
  inspection: boolean;
  dictation: boolean;
  preset?: InstallPreset;
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
    name: "bun" | "node" | "docker" | "flock",
    args: string[],
  ): Promise<string | null>;
  disk(directory: string): Promise<bigint | null>;
  destination(
    directory: string,
  ): Promise<"absent" | "existing" | "unsafe" | "unconfirmed">;
  port(port: number): Promise<boolean | null>;
}
