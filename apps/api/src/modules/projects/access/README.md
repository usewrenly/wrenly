# Deciding who may use a project

Being signed in answers “who is asking?” This folder answers “may they read or change
this project?” The same rules apply to lists, individual project reads and new work.

For example, inviting someone to the instance does not reveal your private projects.
You must share a project with them, or choose to share it with accepted instance members.
Instance administration alone gives no private-project access.

Owners manage and publish. Editors read and contribute. Viewers read and open authorized
ready previews. Archived projects keep history readable but reject new work and changes.

`project-access.ts` defines those **capabilities**—the actions each role may perform.
It also builds database **predicates**, meaning filters that return only allowed rows.
Keep the filters and individual checks equivalent: hiding a detail page is insufficient
if its project still leaks through a list.

The matrix test checks role combinations. The separate disposable database sharing
fixture checks real Better Auth sessions, grant changes and preview revocation. Callers
must still authenticate before using a database filter; a filter is not a login check.

Writers lock queue, account and project in that order. Import the capability types
from this module rather than recreating the permission matrix elsewhere.
