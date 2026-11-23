COMPONENT: Native framework Production runtime acceptance
PURPOSE: Prove real Next.js and Laravel code can persist records through the isolated Production topology, independently of provider status.
INPUTS: Explicit test opt-in, repository toolchains and disposable PostgreSQL/TLS fixtures only.
OUTPUTS: CRUD, isolation and restart evidence; no live installation or provider is modified.
STEPS:
1. Start a uniquely named private TLS PostgreSQL fixture with one database and runtime-only role per framework.
2. Prepare each real framework artifact through the existing sandbox path and its trusted guardian.
3. Create owned socket volumes/network/broker through the fixed runtime-host helpers; generated apps remain network-none and receive settings only on stdin.
4. Send fixture HTTP requests through the owned Unix socket; verify create/read/update persistence.
5. Stop/start the exact app under explicit fixture intent, recheck identities, and verify saved data remains. Refuse a second credential delivery to an already-ready app.
6. Remove only fixture-owned containers, images, networks, files and volumes in finally blocks.
EDGE CASES: Failures retain diagnostic context but never print credentials; missing images fail the opted-in test rather than skip it silently.
ERROR STATES: A compiler, TLS, socket, CRUD or restart failure fails acceptance. This test alone does not claim real Coolify routing or interrupted-effect recovery.
