COMPONENT: Trusted HTTP relay image promotion
PURPOSE: Publish the repository-built credential-free relay to the same authenticated private registry used for application images.
INPUTS: Exact installed relay image ID, validated registry origin/namespace/authentication, explicit local installation confirmation and cancellation.
OUTPUTS: Verified immutable registry reference matching the installed image.
STEPS: Require the fixed local toolchain tag and exact ID/user/entrypoint/labels; reuse private registry anonymous-denial, bounded authenticated push and manifest/config-digest verification; return only non-secret image identities.
EDGE CASES: Runtime application images retain their separate deployment/provenance validation. The generic verifier is private and cannot be selected by model/browser input. Repeating an explicitly requested installation push sends the same immutable image, not a new application deployment.
ERROR STATES: Unauthenticated registry, substituted image or digest/config mismatch stops without enabling Production. Credentials never enter arguments, emitted output or Git; no runtime password is involved.
