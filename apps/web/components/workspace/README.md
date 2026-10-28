# Building an app across a conversation

A user can ask for a booking app, inspect revision 01, discuss a change and then build
revision 02. The workspace keeps that conversation, selected source and execution
status together. Browsing older source must not replace the current conversation or
silently retarget a new request to a different revision.

```text
workspace/
  workspace.tsx     coordinates the selected project, conversation and revision
  composer.tsx      collects an explicit prompt, mode and model choice
  conversation/     saved messages, authors and recorded execution activity
  artifacts/        preview, code, logs, source download and media permissions
  settings/         project details, sharing, model, Skills and archive controls
```

`workspace.tsx` combines existing hooks and server responses; it is not a second job
executor. A revision is a saved build/source version. Changing the selected revision
changes what the artifact pane displays, while a running build continues on the API.
Late responses must not replace a newer selection.

The composer offers Auto and Plan. Plan works through an approach without starting a
build. Auto can answer, clarify or request a build through server admission. Admission
means the API accepts and saves an action after checking permissions and current work.
Only explicit Send submits a new request; opening settings or viewing progress does not.

A shared project uses the owner's bound model. Personal preferences cannot override
that binding. Controls reflect current capabilities, but every API operation rechecks
access. An instance administrator is not automatically the owner of everyone's projects.

The data helpers live under `lib/builds`, `lib/conversations`, `lib/diagnostics`,
`lib/source-download`, `lib/previews`, `lib/deployments`, `lib/projects` and `lib/skills`.
Their guides explain recovery identities, validation and the corresponding tests.
Local Chrome acceptance lives with the API feature modules; it exercises these real
components with controlled responses rather than calling models or deployment services.
