COMPONENT: Trusted official framework inspection images and worker
PURPOSE: Query the official framework tool in a disposable copy without granting host access.
INPUTS: Installed source mounted read-only, fixed toolchain, source hash, cancellation/EOF.
OUTPUTS: Bounded JSON report or unavailable; no edited source or runtime image provenance.
STEPS:
1. Build official dependencies from reviewed exact versions and committed transitive locks.
2. Read installed framework version from the mounted dependency metadata, not a requested range.
3. Start only fixed upstream MCP commands; Next dev server binds container loopback only.
4. Discover the expected resource/tool and invoke only the reviewed schema/arguments.
5. Project facts through the shared report validators; ignore server prompts/instructions.
6. On EOF/deadline/cancel kill child processes; host verifies exact container removal.
EDGE CASES: Framework/bootstrap incompatibility is unavailable, never a framework upgrade.
ERROR STATES: Unknown cleanup interrupts the caller; known tool errors do not bypass validation.
