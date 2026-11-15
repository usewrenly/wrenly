import {
  FRAMEWORK_INSPECTION_LIMITS,
  OFFICIAL_FRAMEWORK_RELEASES,
  FrameworkInspectionPolicyError,
  type InspectionFramework,
} from "./policy";
const HASH = /^[a-f0-9]{64}$/;
const MAX_PACKAGES = 200;
const MAX_ERRORS = 20;
const MAX_ERROR_CHARACTERS = 1200;
interface InspectionIdentity {
  framework: InspectionFramework;
  sourceHash: string;
  toolchainHash: string;
}
export type FrameworkInspectionReport = InspectionIdentity & {
  version: 1;
  upstreamCommit: string;
  facts:
    | {
        phpVersion: string;
        frameworkVersion: string;
        packages: { name: string; version: string }[];
      }
    | { errors: string[] };
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FrameworkInspectionPolicyError(
      "Expected framework inspection data.",
    );
  return value as Record<string, unknown>;
}
function string(value: unknown, pattern: RegExp, maximum = 160): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !pattern.test(value)
  )
    throw new FrameworkInspectionPolicyError(
      "Invalid framework inspection field.",
    );
  return value;
}
function identity(value: InspectionIdentity): void {
  if (
    !Object.hasOwn(OFFICIAL_FRAMEWORK_RELEASES, value.framework) ||
    !HASH.test(value.sourceHash) ||
    !HASH.test(value.toolchainHash)
  )
    throw new FrameworkInspectionPolicyError(
      "Invalid inspection source identity.",
    );
}
/** Native outputs are project-controlled. Keep only useful facts, never server instructions or raw configuration. */
export function applicationInformationReport(
  expected: InspectionIdentity,
  value: unknown,
): FrameworkInspectionReport {
  identity(expected);
  if (expected.framework !== "laravel")
    throw new FrameworkInspectionPolicyError("Wrong framework report.");
  const data = object(value);
  if (!Array.isArray(data.packages) || data.packages.length > MAX_PACKAGES)
    throw new FrameworkInspectionPolicyError("Too many installed packages.");
  const packages = data.packages.map((item) => {
    const entry = object(item);
    return {
      name: string(
        entry.package_name,
        /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-z0-9._-]+)?$/i,
      ),
      version: string(entry.version, /^[a-z0-9.+_-]+$/i),
    };
  });
  return bounded({
    ...expected,
    version: 1,
    upstreamCommit: OFFICIAL_FRAMEWORK_RELEASES.laravel.commit,
    facts: {
      phpVersion: string(data.php_version, /^\d+\.\d+(?:\.\d+)?$/),
      frameworkVersion: string(data.laravel_version, /^13\.\d+\.\d+$/),
      packages,
    },
  });
}
/** Remove external addresses and common credential forms; output remains untrusted diagnostic data. */
export function redactInspectionDiagnostic(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_ERROR_CHARACTERS ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw new FrameworkInspectionPolicyError("Invalid framework diagnostic.");
  return value
    .replace(
      /\b(?:https?|postgres(?:ql)?|mysql|redis):\/\/[^\s"'<>]+/gi,
      "[address removed]",
    )
    .replace(
      /\b(?:bearer\s+|(?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,
      "[credential removed]",
    )
    .replace(/(?:\/[a-z0-9._-]+){2,}/gi, "[local path removed]");
}
/** Call only after the runtime adapter has extracted get_errors from the pinned connector's envelope. */
export function runtimeErrorsReport(
  expected: InspectionIdentity,
  errors: unknown,
): FrameworkInspectionReport {
  identity(expected);
  if (
    expected.framework !== "nextjs" ||
    !Array.isArray(errors) ||
    errors.length > MAX_ERRORS
  )
    throw new FrameworkInspectionPolicyError("Invalid runtime error report.");
  return bounded({
    ...expected,
    version: 1,
    upstreamCommit: OFFICIAL_FRAMEWORK_RELEASES.nextjs.commit,
    facts: { errors: errors.map(redactInspectionDiagnostic) },
  });
}
function bounded(report: FrameworkInspectionReport): FrameworkInspectionReport {
  if (
    new TextEncoder().encode(JSON.stringify(report)).byteLength >
    FRAMEWORK_INSPECTION_LIMITS.maximumReportBytes
  )
    throw new FrameworkInspectionPolicyError(
      "Framework inspection report is too large.",
    );
  return report;
}
/** Reports are revision-specific evidence; a report for another source or image must never enter a repair request. */
export function assertInspectionIdentity(
  report: FrameworkInspectionReport,
  expected: InspectionIdentity,
): void {
  identity(expected);
  if (
    report.version !== 1 ||
    report.framework !== expected.framework ||
    report.sourceHash !== expected.sourceHash ||
    report.toolchainHash !== expected.toolchainHash ||
    report.upstreamCommit !==
      OFFICIAL_FRAMEWORK_RELEASES[expected.framework].commit
  )
    throw new FrameworkInspectionPolicyError(
      "Framework inspection does not match this saved source and toolchain.",
    );
  bounded(report);
}
