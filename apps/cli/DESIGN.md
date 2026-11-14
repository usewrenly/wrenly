# Guided machine checks

COMPONENT: Standalone operator CLI Doctor and Plan
PURPOSE: Explain prerequisites before someone installs Wrenly.
INPUTS: Strict doctor/plan/help arguments, absolute destination and selected ports.
OUTPUTS: Readable report or versioned JSON; exit0 ready, exit1 blocked, exit2 invalid.
STEPS:
1. Validate arguments before probing. Imports/help start no checks.
2. Run bounded fixed version/info commands with no Docker context inheritance.
3. Inspect disk, destination identity and loopback port availability without writing files.
4. Show separate pass/failed/unconfirmed results and a remedy for each failed check.
5. Plan describes proposed future changes but executes none.
EDGE CASES: Existing files are never read for secrets or overwritten; missing Docker
still allows independent checks. A bind probe closes its temporary socket immediately.
ERROR STATES: Timeout or missing evidence is unconfirmed, never success. Unknown
commands/options exit before filesystem/process checks. No install command ships yet.
