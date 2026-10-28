// Trusted PID1 inside database preview containers only; never execute this entrypoint on the API host.
import { runDatabasePreviewBootstrap } from "@wrenly/sandbox/database-application-bootstrap";
await runDatabasePreviewBootstrap();
