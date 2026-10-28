# Managing member access

The instance owner can suspend a teammate who should no longer sign in, then restore
access later. Suspension preserves that person's projects and history; it does not
transfer ownership or delete membership to hide it.

`member-access-manager.tsx` asks for confirmation and records the target account,
action, reviewed access revision and request ID. The revision identifies the state
reviewed before the action. If the response is lost, the component checks that exact
saved request before offering an explicit same-action retry.

A recorded action and current status are different: a later access change can exist.
The UI reports that difference and asks the owner to review current state. It does not
claim its earlier action is still current merely because it was once recorded.

Owner accounts are protected. Missing suspension status or action identity metadata
leaves controls disabled; directory parsing lives in `lib/accounts/member-access.ts`.
The API still checks owner authority and all active-work/session constraints. Browser
controls are guidance, not a substitute for server authorization.

Local Chrome tests in the API auth module cover confirmation, uncertain acknowledgement,
exact retry, conflict review and owner protection across responsive themes.
