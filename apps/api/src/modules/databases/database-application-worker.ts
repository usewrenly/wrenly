// Bundled separately for PID1 inside disposable application containers. Never execute
// this entrypoint on the API host; compilation does not start an application or database.
import { runDatabaseApplicationBootstrap } from "@wrenly/sandbox/database-application-bootstrap";
await runDatabaseApplicationBootstrap();
