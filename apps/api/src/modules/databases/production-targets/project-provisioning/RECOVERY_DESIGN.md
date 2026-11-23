# Inspect before continuing an interrupted creation

COMPONENT: Owner-confirmed SQL creation recovery
PURPOSE: Resolve one uncertain phase without replaying SQL, changing passwords or losing the old request.
INPUTS: Current project owner/session, expected access revision, original creation ID, review request UUID and explicit confirmation.
OUTPUTS: Separate read-only review record, or a separately confirmed resume acknowledgement using the same resource credentials.
STEPS:

1. Keep the original request blocked; under queue/account/project locks reject active claims and capture its exact phase, prior completions and effect time.
2. Claim a separately saved read-only review and acquire the same resource kernel lock as execution, so an old worker cannot overlap it.
3. Recheck private TLS/DNS, immutable app/control cluster identities, minted role password proofs, role flags and phase-specific ownership/grants/schema facts.
4. Save confirmed, absent or refused without running provisioning DDL. An interrupted inspector is never reclaimed automatically.
5. Only an explicit second owner confirmation can consume a successful review. Recheck the original evidence unchanged; confirmed advances its completed prefix, absent preserves it. Keep the old review and original actor/session history.
6. Save current execution-session identity separately and queue only remaining phases; never execute an acknowledged phase again. No ready-resource claim is made by recovery.
   EDGE CASES: Matching names with different passwords, partial/changed grants, unexpected schema objects or unknown facts require inspection rather than adoption. A missing effect intent cannot be treated as confirmed SQL.
   ERROR STATES: Lost review or resume acknowledgement is read back by its UUID. Never clear the old blocker by overwriting status without verified evidence.
