/** Shared source identity and file contracts. They contain no credentials or runtime settings. */
export interface SourceRepository {
  provider: "github";
  id: string;
  owner: string;
  name: string;
  private: boolean;
}
export type { RevisionFile as SourceFile } from "../revision/contracts";
export interface SourceTreeEntry {
  path: string;
  blobId: string;
  size: number;
  executable: boolean;
}
export type SourceFailureCode =
  | "invalid_repository"
  | "identity_changed"
  | "invalid_tree"
  | "unsupported_entry"
  | "unsafe_path"
  | "size_limit"
  | "invalid_content";
/** Fixed messages keep provider payloads and imported content out of errors. */
export class SourceControlError extends Error {
  constructor(public readonly code: SourceFailureCode, public readonly path?: string) {
    super(`Source connection could not be verified (${code}).`);
    this.name = "SourceControlError";
  }
}
