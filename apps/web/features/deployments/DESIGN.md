COMPONENT: Published runtime permission panel
PURPOSE: Let the current project owner review, enable or withdraw exact-publication maintenance.
INPUTS: Project/deployment IDs, current account ID and safe saved API state.
OUTPUTS: Explicit confirmed decisions and actor-scoped pending request metadata only.
STEPS:
  1. Open a standard accessible dialog and read saved permission; opening never enables it.
  2. Explain enable, pause and final revoke choices and confirm the selected action.
  3. Persist the exact decision locally before sending. Disable other decisions while unresolved.
  4. After a lost response, check the original receipt or resend identical input; never infer non-admission from a missing receipt.
  5. Parse safe shared response contracts and refresh server state after an acknowledgement.
EDGE CASES: A different account gets a different storage/query key. Unavailable storage refuses a write. Closing preserves pending decisions.
ERROR STATES: Invalid/server-denied status shows attention without stale controls. Missing receipts preserve pending work. No secret/execution binding is accepted.
