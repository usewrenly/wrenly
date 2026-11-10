# Swappable infrastructure adapters

COMPONENT: Database provider contract
PURPOSE: Keep saved database orchestration independent from Coolify's API and field names.
INPUTS: Exact saved provider ID, resource/operation IDs, frozen non-secret placement and server-only credentials.
OUTPUTS: An opaque remote identity and bounded provider facts.
STEPS: Select an explicitly configured compiled-in adapter, validate its own placement, perform one create or a read-only inspection, and return only common facts.
EDGE CASES: Missing/duplicate adapters fail closed. A saved resource never silently moves to another deployer. TLS configuration is not live TLS verification.
ERROR STATES: Provider-specific failures stay behind adapters. The API retains authorization, encryption, durable intents, kernel locks and recovery.

This is the same adapter boundary already used for provider HTTP integration, not a
new remote plugin protocol. MCP remains the framework-tool protocol. Adding a deployer
does not grant a model permission to provision infrastructure or install arbitrary code.
