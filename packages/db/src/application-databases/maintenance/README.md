# Permission to keep a published app running

A booking app should not stop working just because its owner closes the browser.
However, an old publishing login must not silently become permanent permission to
start containers or send credentials. This folder defines a separately confirmed,
revocable permission for one exact verified publication.

A **grant** records what the owner approved. It freezes the publication's database,
host, app images and completed receipts. It has its own revision: when permission
changes, a worker holding the previous revision must stop before another effect.
The confirming login can differ from the original publishing login.

`contract.ts` validates that non-secret record and compares it with current server
facts. Owner suspension, changed ownership/access, archive, a stopped or changed
database, unverified host, substituted publication or conflicting work refuses
maintenance. Signing out alone is deliberately not a revocation of a separately
confirmed permission. It does not make the original session valid again.

## What this code does not activate

These are pure contracts and eligibility checks. They open no database connection,
run no process, load no credential and accept no browser authority. Durable grant
admission/audit, independent maintenance attempts, execution locks/leases, remote
identity checks, protected credential delivery, owner controls and worker startup
must be connected separately before maintenance is available.

Callers must load current facts themselves under the shared queue/account/project
locks and recheck them immediately before each effect. Never construct current facts
from HTTP input. A successful pure check is not enough to start a container. Existing
publications must never receive a grant automatically.

Tests cover explicit confirmation, complete publication evidence, a different
confirming session, stale/revoked/paused grants, current account/project/resource/host
changes, conflicting work and substituted or secret-bearing data. These tests do not
establish native restart or real Coolify acceptance.
