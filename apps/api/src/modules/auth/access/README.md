# Checking who is signed in

A session is the server record behind a signed-in browser. These helpers check that
the session still exists and the account is still allowed to use this instance.

For example, a member might send a request just before the owner suspends them.
Checking only at the beginning would let that old request continue. Wrenly checks
again before saving work, using the account's current **access revision**—an identifier
that changes when access changes.

- `session.ts` reads browser headers and asks Better Auth for the session.
- `access-context.ts` remembers the verified identity during that one request.
- `access-policy.ts` checks live account/session state again when needed.

The remembered identity is called a **principal** in the code: the account, session
and access revision that were verified. These values come from the server, never JSON
sent by the browser. Its type is defined once as `AccessPrincipal`; callers import it.

Database operations lock the queue before the account, then the project or draft.
Following the same order prevents conflicting operations from waiting on each other
in opposite directions. Trusted background work can run without a browser request,
but must explicitly supply its account; an HTTP endpoint still requires authentication.

Being signed in is not permission to access every project. Project rules live in
`projects/access`. Never log cookies or session tokens when reporting a failure.

`account-work.ts` provides the shared queue locks and checks used before suspension or
password recovery. Both operations must wait for active work or unresolved external
effects; neither operation cancels jobs silently.
