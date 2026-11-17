/** Trusted Production application PID1; never execute this entrypoint on the API host. */
import { runProductionApplication } from "@wrenly/sandbox/production-application-bootstrap";
await runProductionApplication();
