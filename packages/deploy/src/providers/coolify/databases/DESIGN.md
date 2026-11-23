# Private PostgreSQL resources in Coolify

COMPONENT: Coolify Production PostgreSQL adapter
PURPOSE: Translate a saved resource-creation intent into one private, stopped database and recover its exact remote identity.
INPUTS: Provider client, saved resource/operation UUIDs, configured project/server/environment/destination and server-generated setup credential.
OUTPUTS: Remote UUID and bounded non-secret identity facts, never a ready application database.
STEPS:
1. Validate the saved identity and resource-bound management credential.
2. Create PostgreSQL 17 with public access and instant deployment disabled. Use deterministic resource name and operation ownership marker.
3. Return only the UUID; ignore credential-bearing connection URLs in provider responses.
4. Read back that UUID and compare name, marker, database type/image/user/database and public port policy.
5. Recover an uncertain creation using read-only listing plus exact detail inspection. Ambiguous or conflicting identities remain unconfirmed.
EDGE CASES: Cancellation/unknown creation is never retried. A name collision is not ownership. An absent listing is evidence for the caller, not permission to create again.
ERROR STATES: Fixed safe errors, no provider body or secret reflection. API orchestration must persist intent before create and acknowledgement afterward.

This adapter does not start containers, configure certificates, create public routes,
provision SQL roles, or mark resources ready. Private routing, verify-full TLS and
cluster identity must be established separately before runtime attachment. It remains
unused by startup until the durable provisioning flow and live provider acceptance pass.
