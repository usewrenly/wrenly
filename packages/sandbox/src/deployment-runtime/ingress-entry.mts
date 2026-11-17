/** Standalone trusted ingress bundle; never imported by generated code. */
import { runDeploymentIngress } from "./ingress.js";
try {
  await runDeploymentIngress();
} catch {
  process.stderr.write("Deployment ingress could not start.\n");
  process.exitCode = 1;
}
