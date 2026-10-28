# Responsive application navigation

The shell is the navigation around every authenticated screen. For example, a
user can search accessible projects, open account settings or use the same navigation
on a phone. The API owns sessions and project access; this layout only presents them.

COMPONENT: App shell, project rail, search and account controls
PURPOSE: Provide one accessible navigation model across desktop and narrow screens.
INPUTS: Verified app session, authorized-project query, current route and device search/filter state.
OUTPUTS: Responsive layout, real project navigation/search and confirmed sign-out.
STEPS:
  1. Show the 224px rail at desktop widths and use the existing shadcn/Base UI Sheet below 1024px.
  2. Keep the search term in Shell; Cmd/Ctrl+K focuses desktop search or opens the drawer's search.
  3. Let Base UI own modal focus guards, Escape, dismissal and trigger restoration; close on desktop resize and navigation.
  4. Derive context and project states from existing data, keeping deployed-app links separate from project links.
  5. Distinguish loading, request failure, expired session, no projects and no filter matches.
  6. Use a keyboard account menu. Confirm Better Auth sign-out before clearing private query cache and opening sign-in.
EDGE CASES:
  - Long names and 320px screens -> truncate context while retaining accessible names and available navigation.
  - Expired session -> actionable sign-in link; do not present an empty collection.
  - Failed sign-out -> keep current cache/session context and show a retryable message.
ERROR STATES:
  - Project query unavailable -> explicit retry, not fabricated empty state.
  - Sign-out unavailable -> no success navigation or assumed revocation.
