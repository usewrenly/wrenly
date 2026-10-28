# Inspecting the selected revision

Selecting revision 01 of a booking app should show its source, preview and logs even
when revision 02 exists. `artifact-pane.tsx` coordinates that selected view and keeps
local previews separate from published applications.

`code-editor.tsx` browses read-only saved files. `workspace-logs.tsx` searches recorded
build/preview output and labelled publishing status. It does not start work or claim
that publishing status is a deployed application's runtime log.

`source-download.tsx` rechecks the exact saved revision before making a local ZIP.
`preview-media-settings.tsx` lets the owner review exact external image/video hosts;
it does not grant model browsing, external script or container network permission.

The preview/deployment hooks own browser observation and explicit actions. The API
and preview gateway own execution and access. Changing revisions cancels obsolete
observation; it does not prove a previously submitted server operation was cancelled.
