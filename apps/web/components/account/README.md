# Account picture controls

Uploading a new picture first shows a local preview. That preview only means the
browser can display the file—it is not proof that the server saved it.

- `profile-avatar.tsx` displays the authenticated same-instance picture route and
  falls back to initials if the image fails. Remote avatar URLs are not accepted.
- `settings-profile-picture.tsx` handles explicit upload/removal and saved-state checks.
  A lost response keeps the original mutation identity. The user can check saved
  state, then explicitly retry the same change when the server remains unchanged.

The component bounds file size, but the API independently validates/decodes uploads.
Changing a local file preview releases its temporary URL. A confirmed save clears
that file selection; a conflict preserves it for review instead of claiming success.
Reading metadata uses `lib/accounts/profile-pictures.ts` and never repeats a write.

These components are shared by account settings and authenticated identity displays.
They do not change user ownership, membership or project permissions.
