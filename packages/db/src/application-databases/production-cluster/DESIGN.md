# One app-only server, separate project databases

COMPONENT: Shared Production app-cluster provisioning
PURPOSE: Create a separate database and restricted roles for each project without altering another project's permissions.
INPUTS: Resource UUID, server-generated credentials, exact verified app-cluster identity and separately verified control-cluster identity.
OUTPUTS: Separately acknowledged role, database, connection-grant and schema phases. No connection secret enters generated source.
STEPS:

1. Validate resource-derived database/role names and distinct passwords before SQL.
2. Recheck immutable cluster identity and the privileged setup role before each phase; reject the control cluster.
3. Under a transaction advisory lock, refuse existing names and create restricted migrator/runtime/reader roles atomically.
4. Create the project database outside a transaction with connections initially disabled. Never adopt an existing name or replace passwords.
5. Revoke PUBLIC privileges on this database only, grant the project roles connection access, then enable connections in one transaction.
6. Connect to that database, check identity again, assign its public schema to the migrator, and establish runtime CRUD/reader SELECT default privileges.
   EDGE CASES: Database creation cannot share the roles transaction. A caller must durably record each phase and retain its lease/kernel lock; errors require inspection, not automatic repetition.
   ERROR STATES: Fixed safe failures. Never DROP/reset a database, revoke cluster-wide PUBLIC grants, or mark app resources ready here.

The shared bootstrap credential belongs to the instance, not a generated application.
No project role receives superuser, role/database creation, replication or bypass-RLS.
Generated clients still use role-scoped authenticated Unix sockets with blocked IP egress.
