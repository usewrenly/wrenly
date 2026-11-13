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
