# Browser sign-in client

When a user signs in to Wrenly, `auth-client.ts` sends the credentials through Better
Auth to this instance's `/api/auth` routes. Next.js forwards those requests to the
API. Better Auth manages the session cookie; every protected API operation verifies
it. A one-person installation requires sign-in just as a team installation does.

`NEXT_PUBLIC_WEB_URL` is the browser-facing web origin, such as
`http://localhost:3000`. Its validator rejects credentials, paths, query parameters
and fragments with a safe configuration error. It is a public address, never a place
for tokens or passwords. The API proxy address is configured separately.

The client is exported whole so callers use Better Auth's native methods. It is not
an independent account database or an alternative authentication implementation.
First-owner setup and invitations use protected Wrenly endpoints, not public signup.

The entry/access components live in `components/auth`; API session checks remain the
authority. Redirecting to a sign-in page alone does not protect server data.
