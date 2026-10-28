// Bundled as trusted PID1 for Docker acceptance; never executed by the host test runner.
import { runDatabaseApplicationBootstrap } from "../../src/databases/application-runtime/bootstrap";
await runDatabaseApplicationBootstrap();
