// Shared safe user-facing publishing explanations; never raw remote diagnostics.
export const PUBLISHING_ERRORS: Record<string, string> = {
  SOURCE_SYNC_FAILED: "Private source synchronization could not be confirmed.",
  ARTIFACT_BUILD_FAILED: "The offline publishing image could not be built.",
  REGISTRY_UPLOAD_UNCONFIRMED:
    "The private image upload could not be confirmed.",
  APPLICATION_CONFIGURATION_FAILED:
    "Deployment application configuration could not be confirmed.",
  READINESS_UNCONFIRMED:
    "The application may be running, but Wrenly could not verify its public URL and published revision. Check the deployment routing and reconcile this attempt before publishing again.",
  EXECUTION_INTERRUPTED: "Publishing execution was interrupted.",
};
