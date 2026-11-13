COMPONENT: Fixed database application composition
PURPOSE: Describe a network-isolated application and credential-free HTTP ingress for the selected deployment.
INPUTS: Exact app/ingress image digests and deployment/project/database UUIDs.
OUTPUTS: Fixed JSON Compose document and deployment-owned external socket volume names.
STEPS:
1. Validate every identity and exact image digest; accept no commands, credentials, mounts or network names.
2. Derive independent HTTP/database socket volume names from the deployment UUID.
3. Keep the app network disabled, filesystem read-only and child-switching capabilities narrowly bounded.
4. Give ingress only the read-only HTTP socket, a normal network and its exact trusted image.
5. Leave restart and credential delivery under the saved publishing lifecycle, never Docker environment values.
EDGE CASES: Existing source-built images do not acquire trusted provenance by appearing in this document; the executor independently verifies both images and all host objects before use.
ERROR STATES: Invalid identity/digest fails before a provider mutation. No user-provided Compose fragments are accepted.

COMPONENT: Coolify database runtime service adapter
PURPOSE: Create the fixed composition without starting it, then verify the same saved service before explicit startup.
INPUTS: Configured provider client, immutable composition input and reviewed Coolify project/server/environment.
OUTPUTS: One service UUID, verified unchanged raw composition or explicit queued-start acknowledgement.
STEPS:
1. Validate placement and build the fixed document locally.
2. Submit base64 Compose through POST /services with immediate deployment, extra network attachment and domain overrides disabled.
3. Require an exact service UUID receipt; never retry creation automatically.
4. GET that UUID and require original name/raw composition/network flag before later actions.
5. Start only through an explicit saved caller action; a queue receipt does not prove runtime readiness.
EDGE CASES: A changed or uncertain remote result needs caller-owned inspection. Similar names do not establish ownership.
ERROR STATES: Return fixed failures without remote bodies or credentials; no automatic retry, adoption or source rebuild.


COMPONENT: Read-only service creation recovery
PURPOSE: Identify one original inert service after its creation acknowledgement was lost.
INPUTS: Exact saved composition, pinned project/server/environment and a bounded provider client.
OUTPUTS: Verified service UUID, explicit absence or safe refusal; no mutation.
STEPS:
1. Read the pinned project, environment and server; verify their numeric/UUID relationships.
2. Require a complete bounded team service collection with unique IDs and exactly one matching deployment name.
3. Independently read that candidate and require its original server/environment, non-deleted state and exact raw composition/network flag.
4. Recheck cancellation before returning its ID. Never call a create/start endpoint.
EDGE CASES: A friendly name only selects a candidate. Duplicate names, incomplete collections and foreign placement fail closed.
ERROR STATES: Unknown responses do not establish absence. The caller preserves its original pending effect.

Provider response fields are defined by Coolify's public service, server and project
environment endpoints. The adapter checks relationships rather than assuming numeric
IDs are UUIDs. Reference: https://coolify.io/docs/api/endpoints/services/get-service-by-uuid
and https://coolify.io/docs/api/endpoints/projects/get-environment-by-name-or-uuid .
