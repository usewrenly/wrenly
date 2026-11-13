# Permission to keep a published app running

When a project owner signs out, their published booking app should keep working.
Maintenance permission records a separate, explicit decision to keep one exact
publication running. It never reuses an expired login or authorizes publishing a
new version.

`store.ts` saves the permission and an immutable action receipt together. A receipt
is the saved result of a button click: checking it after a lost reply cannot click
the button again. A revision identifies the version the owner reviewed, so two
screens cannot silently overwrite each other's decisions.

An owner can enable, pause or revoke permission. Enabling requires a successful
publication, unchanged database/schema and verified host, with no active or uncertain
project work. Pausing and revoking still work when infrastructure is unavailable,
and an archived project's owner can withdraw permission. Revocation is final for
that publication; a newly published version needs a new explicit decision.

`loadMaintenanceAuthority` checks current account, project and infrastructure records
under shared locks. It deliberately does not read the original publishing session.
Suspension, account/access changes, archive, changed resources or inactive permission
refuse authority. This function loads no credentials and starts no container.

Migration 0047 adds the permission and owner-action tables. The integration test uses
only a guarded disposable PostgreSQL database. It proves transaction/replay and access
rules, not a host restart. Worker attempts, remote restart and browser controls remain
separate integration steps and are not activated by this storage module.

## Separate restart attempts

`claims.ts` creates one bounded worker claim after rechecking the stored permission.
An attempt has a short lease (an expiry time for worker ownership), its own token,
and an ordered journal. `advanceMaintenance` saves the next intent before a caller
may perform an effect, then records its separately verified acknowledgement. A
second worker, stale token, withdrawn permission or expired lease cannot advance it.
Expiry preserves the pending action as interrupted; no automatic retry is admitted.
Migration 0048 stores these attempts independently of owner decisions and publication
receipts. These helpers still do not start a scheduler or send any credential.

## Host execution

`services.ts` connects those saved claims to the credential loader, host helper and
public-route verifier. `host-adapter.ts` inspects the original container IDs before
starting a stopped process. It refuses a replacement and never resends credentials to
a running process. `worker.ts` owns the publishing kernel lock and renews its short
lease while the adapter runs; closing a browser does not own or cancel this work.

The host helper's `broker-restart.ts` checks the daemon, image, network, storage and
isolation policy under one host lock. It starts only the preserved broker and delivers
its existing runtime role through stdin once. Publishing receipts remain unchanged.
This is an execution layer, not activation of a periodic scheduler or owner controls;
those require the remaining admission/lifecycle and end-to-end checks.
