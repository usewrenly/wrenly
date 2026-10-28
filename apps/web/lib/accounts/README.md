# Account pictures and invitation requests

These helpers connect account screens to Wrenly's own API. For example, the header
can read your saved picture, while the owner can issue a private invitation for a
teammate. They do not bypass Better Auth or grant access in the browser.

- `profile-pictures.ts` checks that returned picture metadata belongs to the signed-in
  account and uses the expected same-instance image route. It retains only user ID,
  revision, mutation ID and picture URL. A revision identifies saved picture state;
  a mutation ID identifies one upload/removal for explicit confirmation and retry.
  React Query cancels obsolete reads, and each request has a 10-second deadline.
- `invitations.ts` sends same-origin requests with session credentials, no caching and
  a 15-second deadline. Safe API errors remain readable. A failed connection or an
  unreadable response is unconfirmed, so users check saved state before retrying.
- `member-access.ts` validates and projects the private member directory for settings.
  Missing access flags do not become implicit authority; contradictory owner metadata
  is rejected.
- `tests/unit` checks identity, metadata projection, cancellation, safe errors and
  the absence of automatic mutation retries.

Picture upload/removal controls live in `components/account`; viewing metadata never
uploads a picture. Invitation proof and credentials must not enter browser storage.
The invitation page clears sensitive proof after failed acceptance. The API enforces
owner/member/session rules for all operations; a hidden browser control is not access
control. Member suspension also uses this request helper, but its action/reconciliation
state stays in the member management component and server module.

From the repository root:

```bash
bun test apps/web/lib/accounts/tests/unit
```

Local Chrome acceptance lives with the API authentication browser tests. It uses
controlled responses rather than sending real invitations or changing real accounts.
