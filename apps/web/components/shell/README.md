# Navigation around the workspace

The shell is the interface surrounding an authenticated page: project links, search,
account controls and the mobile navigation drawer. For example, someone can search
for a booking project on a laptop and find the same project from the phone drawer.
It does not create a second set of permissions; the API decides which projects and
member data that account may read.

- `shell.tsx` owns navigation search and drawer state. Cmd/Ctrl+K focuses search;
  Base UI manages the drawer's focus, Escape and focus restoration. Navigation or
  resizing to desktop closes the mobile drawer.
- `project-rail.tsx` shows authorized projects, with at most six recent matches,
  search/status filters and a link to the complete Projects collection. Failure,
  expired sign-in, no projects and no search results stay distinct.
- `top-bar.tsx` provides the page context, search target and account/member controls.
- `account-menu.tsx` uses Better Auth for sign-out. It clears private query caches
  and navigates only after confirmation. Failed sign-out retains the current context
  and gives an error instead of claiming the session was revoked.
- `instance-members.tsx` requests the private directory only for the verified owner
  role. It shows a compact set of avatars; actual invitation authority is server-side.
- `setup-progress-card.tsx` shows saved incomplete/actionable setup steps. It is not
  a live provider health check or an invented percentage score.

The member-management controls live in `components/settings/access`, independently
of this navigation. Profile rendering lives in `components/account`. Both use their
corresponding account clients instead of duplicating session or credential storage.

`DESIGN.md` explains navigation states and failure behavior. Local Chrome navigation
acceptance lives with the API auth tests and checks desktop/mobile search, focus,
filters, error recovery and failed/confirmed sign-out without touching real accounts.
