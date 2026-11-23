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
rules, not a host restart. Storage does not itself run a host check; the explicit Production activation owns
the scheduler and its awaited shutdown.

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
`scheduler.ts` visits saved grants in bounded pages and refuses unfinished attempts.
`production.ts` reconstructs images and provider settings from the original successful
publication and matching verified instance configuration. Production activation starts
this loop only after its existing toolchain/module checks; stop waits for its held work.

`owner-state.ts` and `http.ts` expose a small owner view and decision receipt lookup.
The deployment-history dialog saves pending choices in account-scoped browser storage
and checks the same receipt after a lost reply. Neither public response includes the
execution binding, claims or credentials. Pause and revoke remain available without a
healthy host. They change permission, not the currently running application's state.

## Stop an app or inspect an interrupted check

Pausing permission and stopping an app are different decisions. **Stop published
app** first pauses maintenance in the same transaction that saves the Stop
request. It then stops the original application and database broker, preserving
both containers, all volumes and the upstream database. A background check cannot
restart them while permission is paused. Resuming maintenance is a separate owner
confirmation.

`owner-control.ts` saves each current-owner Stop or inspection independently of
background attempts. `control-services.ts` opens only the deployment-host SSH key;
these operations never load an application's database password. The fixed host
helper checks ownership, images, isolation and immutable container IDs before Stop.

**Inspect saved runtime** reads the original broker, application guardian and HTTP
revision marker. It starts nothing and sends no application credentials. If the
runtime is stopped or only partly running, the owner may explicitly Stop it to
prove a stopped outcome instead. Missing or replaced resources remain blocked.

After positive proof, the old attempt becomes `reconciled`: its original pending
intent and earlier acknowledgements remain intact, with a separate reference to
the control that resolved it. A lost response is checked by request ID; retrying
that same request returns its receipt and never repeats remote work.

`control-http.ts` checks trusted origins, bounded strict input and the active owner
session. The browser retains pending actions across remounts. A lost session does
not erase the journal; an expired lease exposes the unfinished action for review.

Native, browser and disposable PostgreSQL acceptance cover these paths. Actual
isolated Coolify and combined release acceptance remain separate gates, so the
module stays Experimental.
