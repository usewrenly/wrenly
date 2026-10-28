# Messages and execution activity

A model's explanation is a message; “Installing dependencies” is an execution event.
These components keep them distinct so users can understand what Wrenly actually did.

`conversation-timeline.tsx` combines saved turns/messages and build activity.
`timeline.tsx` provides attributed prompt and outcome rows, including older build-only
history. `assistant-message.tsx` renders Markdown without raw HTML or automatic images.
`execution-activity.tsx` reads recorded operation steps, not private model reasoning.
`skills-used.tsx` shows the exact instruction versions used by saved work.

`copy-message.tsx` copies text without mutating history. Editing/resubmitting a prompt
creates a new request; it does not rewrite an old message. Revision actions require
explicit author identity and contribution permission from the surrounding workspace.
