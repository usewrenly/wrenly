# Saving ideas before building

A draft is a saved idea, not a generated app. For example, write a rough booking-app
idea, share it with a teammate and refine it before sending a build prompt. Merely
loading or saving that text never starts a model request or creates an executable app.

`project-drafts.ts` validates draft content, sharing roles and lists, and sends
same-origin authenticated requests with a 10-second deadline. Editor operations
validate the returned draft ID against the selected idea. Creation also checks the
acknowledgement against the draft ID included in its original request.

A **revision** identifies the saved state that was reviewed before an edit. The API
checks it when applying changes; a changed revision means the user must review the
newer state rather than overwrite it unknowingly. An **uncertain acknowledgement**
means the server may already have saved the change. The UI keeps its request ID and
reviewed text for an exact retry instead of submitting a different mutation.

The API owns access checks. Owner, Editor and Viewer controls reflect its response,
but do not replace those checks. Malformed permission metadata is rejected before
enabling editing or sharing controls. Archived ideas remain separate from archived
executable projects and their deployment resources.

The UI lives in `components/drafts`. Its editor keeps unsaved text during polling,
checks revision conflicts and offers an explicit reviewed handoff to the composer.
The user still has to send that prompt; opening the handoff does not admit a build.

From the repository root:

```bash
bun test apps/web/lib/projects/drafts/tests/unit
```

Chrome acceptance lives with the API projects browser tests and uses controlled local
responses. It checks creation/save retries, conflicts, archive, viewer access and
handoff without inference or generated execution.
