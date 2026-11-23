# Official framework inspection

A failed Next.js app can have an error that the framework understands better than
our generic build log. This folder defines the small set of official inspection
requests Wrenly may make against a disposable copy of that app.

A policy is a rule checked before execution. `policy.ts` pins the upstream packages,
recognizes compatible installed versions and constructs fixed MCP requests. It does
not launch programs, discover host ports or contact a database. The Docker execution
adapter must enforce isolation and source identity independently.

Boost 2.10.4 exposes application information through an MCP **resource**: a named
read operation. That release does not contain a route-listing tool. Next.js DevTools
0.4.0 forwards `get_errors` to a fixed development port inside its container; Next.js
15 is unsupported by that runtime feature and is never automatically upgraded.

`report.ts` projects package/version facts, bounds diagnostic text and checks source/
toolchain hashes. Diagnostic text remains untrusted data even after redaction; it
must never be promoted into tool permissions or system instructions.

This policy is an implementation foundation. No inspection execution is activated yet.
