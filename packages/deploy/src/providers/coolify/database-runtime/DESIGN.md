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
