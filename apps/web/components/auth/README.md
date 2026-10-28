# Entry pages and protected screens

A new installation needs protected first-owner setup; an existing installation needs
sign-in. These components ask the API which flow applies. A failed request never means
“no accounts exist,” and never permits private screens to render.

- `instance-entry.tsx` checks saved instance setup state and routes between setup and
  sign-in. Existing accounts needing owner recovery cannot create another first owner.
- `auth-guard.tsx` waits for authenticated access before rendering private content.
  It offers retry when verification fails and cancels stale checks on unmount.
  Successful entry stays on the loading screen for at least 1.2 seconds to avoid a
  distracting flash. That timer never grants access or delays errors/sign-in redirects.
- `entry-frame.tsx` provides the shared visual layout and instance-authentication footer, with
  “Read more” linking to the account guide. The sign-in form owns its setup link. It does not
  make permission decisions.
- `password-input.tsx` provides explicit reveal/hide without changing form submission.

The route forms remain under `app/(auth)`. Setup/recovery proof from a URL fragment
(the part after `#`) stays in memory and is removed from browser history. It must not
be copied to browser storage or ordinary query strings. Better Auth owns sign-in and
sessions; the API protects setup, recovery, invitation and membership operations.

Browser access controls guide navigation. They do not replace authorization on each
API request. Local Chrome tests in the API auth module exercise failure/retry, stale
responses and responsive entry presentation using controlled services.
