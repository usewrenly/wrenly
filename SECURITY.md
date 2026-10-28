# Security policy

Wrenly is pre-release software preparing a public beta. There is no stable supported
release line yet, no certification claim and no claim that an automated test suite is
a completed security audit. Use the current development revision for evaluation and
review the release notes when a tagged beta is available.

## Report a suspected vulnerability privately

If the repository's **Security → Report a vulnerability** option is available, use it
for a private advisory. If it is unavailable, ask the maintainer to establish a private
reporting channel without posting exploit details or secrets publicly. Private reporting
must be enabled/configured by the repository owner before public release; no unverified
contact address is supplied here. An acknowledgement/fix SLA has not been established.

Include affected revision, reproduction steps, impact and a minimal sanitized example.
Do not include live credentials, personal subscriber data, generated private source or
one-time setup/removal links. Test only installations and infrastructure you control.

## Boundaries contributors must preserve

- Every instance requires a current Better Auth session; knowing its address or setting
  the old single-user flag never grants anonymous project access.
- Membership does not grant private project access. Sharing roles, access reductions,
  session revocation and archived-project fences must be rechecked server-side.
- Generated validation/runtime code stays isolated in Docker. Credentials and control
  database access must not enter generated source, image layers or unrestricted networks.
- Publishing promotes a sandbox-built image through a private registry. Never restore
  the removed public-clone/source-rebuild path to bypass an error.
- Skills are frozen instructions, not executable packages, browsing access or permission
  to use tools. Preview-media approval grants only exact reviewed browser media origins.
- Local instance data does not require external Wrenly services. Hosted inference is an
  explicit provider choice. Provider credentials and optional external integrations must remain separate from the control database and generated source.

Generated-app Development databases are experimental and require explicit opt-in.
Production app-database provisioning and database-backed publishing, additional provider
protocols, Figma/MCP connector activation and alternative deployers remain incomplete. Do not rely on
unimplemented boundaries as if they are available safeguards.

If a credential is exposed, revoke/rotate it at its provider and inspect access using
that provider's controls. Removing text from the current tree alone does not invalidate
it or remove it from Git history. Preserve evidence without redistributing secret values.
