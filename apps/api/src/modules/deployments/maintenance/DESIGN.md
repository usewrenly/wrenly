COMPONENT: Published runtime maintenance permission storage
PURPOSE: Save explicit owner permission for one successful publication without using its old browser session as ongoing authority.
INPUTS: A current owner session, deployment ID, reviewed project/grant revisions, action UUID and enabled/paused/revoked choice.
OUTPUTS: A non-secret persisted grant and an immutable owner-action receipt; no remote effect.
STEPS:
1. Acquire global queue locks, then account and project locks. Verify the current owner session directly.
2. Return only an identical actor-scoped action replay; reject reused IDs with different input.
3. Compare reviewed project/grant revisions. Enabling requires an idle project and exact successful publication/resource/verified host relationships.
4. Freeze separately confirmed owner authority and the full publishing journal. Save grant and action atomically.
5. Pause/revoke without requiring healthy infrastructure or idle work so an owner can always withdraw permission. A revoked grant cannot be resumed; a new publication requires its own permission.
EDGE CASES: Signing out does not erase stored permission. Suspension, archive, access changes or stale evidence block later use. A later decision never rewrites an earlier receipt.
ERROR STATES: Stale revisions and unavailable evidence return a conflict. Database failures do not imply an external action occurred because this component performs none.

Worker attempts and external restart remain disconnected until independently verified.

ATTEMPT STORAGE: Under the same queue/account/project locks, recheck the enabled grant
and exact successful publication, reject every unfinished project attempt, then create
a 30-second claim and independent journal. Before intent/ack/renewal, check token,
grant revision, current owner/resource/host facts and expiry. Expiry records interruption
without erasing the intent or requiring an active grant. Retain all previous attempts.
Remote effects require separate kernel locks and independently verified receipts;
these storage helpers alone never perform them.

EXECUTION COORDINATOR: Load a held attempt and enabled grant, persist one intent,
reload the exact saved grant/journal, perform its independently implemented adapter,
then acknowledge only that effect. Check cancellation and kernel-lock/lease ownership
before and after the external call. Bound the loop by the shared step list. Any failure
returns attention without starting a second attempt or clearing the pending intent.

CONNECTED ADAPTERS: Secret selection accepts an authority callback executed inside its
transaction. Maintenance supplies its own held grant/attempt; publishing keeps its live
session checks. The host adapter inspects saved broker/app IDs and policies before a
single stopped-resource restart. Running resources are never sent credentials again.
The route adapter verifies the unchanged completed composition and public marker using
the independent maintenance effect ID; it never modifies publishing receipts.
The worker holds the same per-deployment kernel lock as publishing, renews independently
of browser subscriptions, shares concurrent renewal checks, aborts on lease/authority
loss and waits for owned work before lock release. Scheduler activation and UI remain
gated until cross-module lifecycle blockers and joined acceptance are complete.


COMPONENT: Maintenance lifecycle fences
PURPOSE: Keep account and infrastructure changes from invalidating unfinished remote work.
INPUTS: Shared queue locks, saved maintenance attempts, optional project owner ID.
OUTPUTS: A blocker for every unfinished attempt, including interrupted work.
STEPS:
  1. Under the same queue locks used by admission, read saved attempts.
  2. For suspension, join the owning project and match only the affected owner.
  3. For instance connection replacement, block any unfinished maintenance.
  4. Preserve explicit permission withdrawal even while an attempt needs review.
EDGE CASES:
  - Completed attempts do not block changes.
  - A different member's account is not blocked by an unrelated owner.
ERROR STATES:
  - An unreadable journal or database fails closed; no account/server change proceeds.

COMPONENT: Owner maintenance controls and scheduled checks
PURPOSE: Expose separately confirmed permission and run bounded saved-grant checks independently of a browser.
INPUTS: Current owner session, project/publication IDs, strict decision UUID/revisions; verified server configuration.
OUTPUTS: Public permission/status projection, immutable decision receipt and independently journaled maintenance attempts.
STEPS:
  1. Owner reads lock/check the current account and project; project readers cannot retrieve grants or receipts.
  2. Return only decision state/revisions and latest result/step/time, never binding, tokens, credentials or raw errors.
  3. POST uses bounded input and trusted origin; GET receipt lookup only reads the actor's saved action.
  4. Browser saves the exact pending decision locally before sending; lost replies retain it for receipt lookup or identical retry.
  5. A server loop visits enabled saved grants in bounded pages. Under queue locks, refuse unfinished attempts and enforce a minimum interval.
  6. Reconstruct image/provider inputs from saved publication plus matching verified installation settings. Await each held attempt and shutdown.
EDGE CASES:
  - Pause/revoke prevents the next remote effect without requiring a healthy host.
  - An expired or pending attempt is never automatically replayed; it remains visible as needing review.
  - No grant means no maintenance; opening controls never enables permission.
ERROR STATES:
  - Lost browser response retains exact request identity.
  - Changed configuration or inaccessible saved evidence refuses execution.
  - Worker failures remain journaled; the scheduler cannot dismiss an uncertain result.
