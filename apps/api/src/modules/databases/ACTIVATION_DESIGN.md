COMPONENT: Development database module activation
PURPOSE: Enable the approved Development workflow only with verified host services and coordinated shutdown.
INPUTS: Validated opt-in environment, current authenticated sessions, trusted ingress and saved resource/build identities.
OUTPUTS: Authenticated feature metadata, database handlers, database-capable build/preview workers and awaited cleanup.
STEPS:
1. Keep the flag false by default; enabling requires local previews and trusted database toolchains/bundles/kernel locks.
2. Compose owner/read APIs and new-choice admission permission from the same flag.
3. Announce Development capability in authorized project snapshots; the browser mounts selector/pane only then.
4. Preview POST derives only the resource saved with that exact successful build, rechecking its current revision and validated/applied schema.
5. Run stateless and database preview workers with disjoint claim/recovery paths and the existing shared capacity fences.
6. Gateway lookup checks both owned runtime maps; failure/startup/shutdown await all lifecycles.
EDGE CASES:
- No selected resource stays stateless. Database declarations without saved choices remain refused.
- A resource revision may advance after reviewed migrations; the same saved resource is revalidated, never replaced.
- Production provisioning/publishing database adapters remain unavailable; this flag enables Development only.
ERROR STATES:
- Missing toolchain/bundle/host prerequisite prevents activation. Unknown effects retain durable recovery fences.
- This design covers wiring; native generated-project acceptance must pass before enabling the opt-in in an operator instance.
