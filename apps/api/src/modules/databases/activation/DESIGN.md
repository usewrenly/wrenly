# Own Production activation in API startup

COMPONENT: Production database activation
PURPOSE: Connect the verified server/host/resource workers and publishing adapters under the API lifecycle.
INPUTS: Explicit validated Production opt-in, existing Development/publishing configuration, exact trusted broker/ingress image IDs and private ingress digest reference, current session resolver.
OUTPUTS: Verified HTTP handlers, publishing adapters and one awaited cleanup handle.
STEPS:
1. When disabled, return without checking images, creating keys, starting workers or mounting Production routes.
2. Require database previews and private publishing to be enabled; validate every image identity before side effects.
3. Inspect the trusted local repository-built broker and ingress images and require the configured IDs, fixed user/entrypoint and ingress labels.
4. Construct the configured Coolify placement verifier and start the cluster module only after its persistence/helper checks pass.
5. Give its verified handlers to production HTTP composition, and give its runtime adapters to the existing durable publishing worker. Admission permits database-backed publishing only with this same active module.
6. API binds the port before startup, accepts no requests until all workers are ready, and awaits every started worker on startup failure/shutdown.
EDGE CASES: Missing trusted images or helpers fail startup with a bounded setup message. Existing stateless publishing does not require Production images. Existing immutable resource/host bindings are never retargeted by changed configuration.
ERROR STATES: Never degrade an enabled-but-invalid Production installation to partial readiness; cleanup failures remain explicit. Default opt-out starts no Production work.
