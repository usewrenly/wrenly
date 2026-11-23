# A separate database for each generated app

A booking app and a notes app can share Wrenly's dedicated app database server without
sharing their databases or passwords. This folder creates that separation. It never
connects generated code to Wrenly's accounts, prompts or project history.

A PostgreSQL **cluster** is one server installation. A **role** is a database account.
Each project gets three roles: the migrator changes its tables, the runtime account
reads and saves application data, and the reader inspects data without writing it.
None can create roles or databases, become a superuser or bypass row security.

`contract.ts` derives names from the resource UUID and generates independent passwords.
`provisioning.ts` performs four separate steps: create roles, create a database with
connections disabled, grant access and enable connections, then initialize its schema.
Only the newly created database's grants change; another project's grants stay intact.

PostgreSQL cannot create a database inside an ordinary transaction. The caller must
therefore save an intent and acknowledgement for each exported step, hold its saved
work claim and execution lock, and inspect uncertain outcomes before allowing another
action. A matching name is not permission to adopt an existing database or replace
its passwords. These functions never drop a database or reset saved data.

Every step checks the immutable server identity and rejects the control cluster,
including when another hostname points to it. Connections must already be private,
TLS-verified, pinned and bounded by the caller. These functions do not open connections,
enable a worker or mark a resource ready. The Production UI remains unavailable until
runtime, backup, migration, recovery and publishing acceptance is complete.

Tests use disposable PostgreSQL only. The integration fixture checks two project
databases, CRUD privileges, denied cross-project connections and refusal to recreate
existing resources. Never point that fixture at an actual Wrenly installation.
