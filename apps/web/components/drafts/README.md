# Draft screens

These screens give unfinished ideas a home before they become app prompts. For
example, the collection can create “Booking app ideas”; the editor lets its owner
invite selected teammates to read or refine that text.

- `draft-collection.tsx` lists authorized ideas and explicitly creates one. A lost
  creation response retains the original request/draft IDs for retry.
- `draft-editor.tsx` separates the last reviewed saved state from unsaved text and
  newer server state. Polling must not erase edits. Content, sharing and archive
  changes retain their reviewed revision and request identity until confirmed.

The editor ignores late responses from cancelled polling/search operations. Access
loss hides current server data and blocks changes. A conflict requires review;
rechecking a save never changes its original meaning. **Use as prompt** requires
saved, reviewed text and opens a handoff—the composer still requires Send.

Validation and API requests live in `lib/projects/drafts`; the API decides permissions.
Routes under `app/(app)/projects/drafts` select these screens and key the editor by ID
so navigating to another idea does not reuse the previous editor's unsaved state.
