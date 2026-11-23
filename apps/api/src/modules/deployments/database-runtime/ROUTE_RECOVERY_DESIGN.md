COMPONENT: Read-only Production route reconciliation
PURPOSE: Settle an interrupted final route check without repeating publishing mutations or SQL.
INPUTS: Explicit operator command, deployment UUID, original active owner/access binding, unchanged configured targets and trusted images.
OUTPUTS: Verified success or the unchanged unresolved runtime effect; earlier mutations are never replayed.
STEPS:
1. Hold the existing deployment kernel lock. Under queue/account/project locks, accept only an interrupted Production deployment whose first seven runtime receipts are complete and whose only pending effect is route verification (or whose final receipt was saved before a lost completion acknowledgement).
2. Require no live lease, cancellation, unrelated remote intent or other running deployment. Keep the original binding and receipt identities; save a fresh, renewing verification claim.
3. Reuse exact host/service/image/broker/application and public revision checks. All external calls are read-only; no application password is sent.
4. Under the current lease and original binding, acknowledge only the previously saved route intent, then use the existing completion guard. A lost local acknowledgement can be checked again without rerunning remote work.
5. On failure, keep the runtime history and restore interrupted status. Never clear or adopt a different pending effect.
EDGE CASES: Expired/revoked original authority, changed database/host/source or offline infrastructure prevents reconciliation. Earlier unknown effects require their own inspection path.
ERROR STATES: Missing/mismatched proof retains the blocker. This command cannot restart containers, recreate services, rerun migrations or publish a different version.
