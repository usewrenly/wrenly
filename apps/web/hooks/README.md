# Connecting screens to ongoing work

A React hook connects a screen to state that changes over time. For example, opening
a booking-app revision should restore its saved build and preview status, then show
later updates. Switching revisions must stop old responses from replacing the new view.

- `use-build-stream.ts` observes persisted build state/events; closing its subscription
  does not cancel server execution. Data clients live in `lib/builds`.
- `use-conversation.ts` restores messages and uncertain same-request acknowledgements;
  it never rewrites conversation history to retry a prompt. See `lib/conversations`.
- `use-local-preview.ts` observes previews and exposes explicit prepare/stop/open
  operations. Frame links are checked by `lib/previews`; the API grants access.
- `use-deployment.ts` polls publishing and retains a saved request key across uncertain
  acknowledgements. `lib/deployments` handles key validation/persistence.
- `use-projects.ts` loads accessible project summaries with distinct expired-session
  and service errors. It passes cancellation and a deadline to uncached requests
  and validates public summaries through `lib/projects/collection`.
- `use-mobile.ts` tracks a responsive breakpoint; it does not decide access permissions.

These hooks manage browser observation and user actions, not server job execution.
The API rechecks authorization and owns durable work. A cancelled read does not prove
that an earlier mutation failed; recovery uses the saved operation identity.
