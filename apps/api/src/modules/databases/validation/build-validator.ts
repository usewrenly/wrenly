/**
 * COMPONENT: Database-aware build validation adapter
 * PURPOSE: Route only explicitly selected saved builds to disposable database validation.
 * INPUTS: Database, existing stateless validator and optional controlled execution adapter.
 * OUTPUTS: Build validator with distinct success, known failure and interrupted behavior.
 * STEPS: Leave absent selections stateless, check selected manifest/framework, use one
 * bounded deadline for preparation/checks, and stop repair retries on unresolved outcomes.
 * EDGE CASES: Model-mentioned databases never provision/select resources; saved selection is rechecked by storage.
 * ERROR STATES: Missing manifest is repairable; uncertain external work throws a fixed interruption.
 * Activation is explicit: ordinary production worker wiring does not install this factory yet.
 */
import type { db } from "@wrenly/db";
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import {
  AppDatabaseManifestError,
  readAppDatabaseManifest,
} from "@wrenly/sandbox/database-manifest";
import type { BuildExecutorDependencies } from "../../builds/execution/build-executor";
import { BuildExecutionInterruptedError } from "../../builds/execution/build-interruption";
import { executeDatabaseBuildValidation } from "./build-validation";

const VALIDATION_TIMEOUT_MS = 300_000;
type Validate = BuildExecutorDependencies["validate"];

/** Constructing this adapter starts no work; its executor never returns unknown work as a repairable compile error. */
export function createDatabaseBuildValidator(
  database: typeof db,
  stateless: Validate,
  execute: typeof executeDatabaseBuildValidation = executeDatabaseBuildValidation,
): Validate {
  return async (files, claim, signal, attempt) => {
    if (claim.input.databaseV1 === undefined)
      return stateless(files, claim, signal, attempt);
    const selected = BuildDatabaseSelection.safeParse(claim.input.databaseV1);
    if (!selected.success || !["nextjs", "laravel"].includes(claim.input.stack))
      throw new BuildExecutionInterruptedError();
    try {
      if (!readAppDatabaseManifest(files, claim.input.stack))
        throw new Error("Missing database manifest");
    } catch (error) {
      const detail =
        error instanceof AppDatabaseManifestError
          ? error.message
          : "Check the saved manifest and migration file paths.";
      return {
        success: false,
        output: "Generated database source did not pass validation: " + detail,
        error: detail,
      };
    }
    try {
      const result = await execute(
        database,
        claim,
        {
          operationId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          resourceId: selected.data.resourceId,
          resourceRevision: selected.data.resourceRevision,
          deadlineAt: Date.now() + VALIDATION_TIMEOUT_MS,
        },
        signal,
      );
      if (result.outcome.status === "interrupted")
        throw new BuildExecutionInterruptedError();
      return result.outcome.status === "success"
        ? {
            success: true,
            output:
              "Saved application migrations and HTTP readiness passed against a disposable PostgreSQL database. Temporary resources were cleaned up.",
          }
        : {
            success: false,
            output:
              result.outcome.diagnostics ??
              "Disposable application database validation failed after confirmed cleanup.",
            error:
              result.outcome.diagnostics ??
              "Check the saved framework migrations and database-dependent page behavior.",
          };
    } catch {
      throw new BuildExecutionInterruptedError();
    }
  };
}
