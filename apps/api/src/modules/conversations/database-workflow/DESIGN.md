# Building with a database from chat

A request such as “Build a notes app that remembers notes” produces an approval card.
The owner approves setup once; the server follows saved database operations and then
admits one build using the exact saved model, Skills and source revision. A later card
shows the actual migration files before backup, rehearsal and persistent application.

The workflow remembers each next action before calling an existing service. Its UUID
and exact input survive restart, so replay reads the same receipt. The browser only
approves and observes. Unknown effects stay blocked; model text never executes SQL.
Each phase rechecks the approving session and project revision. Plan cannot create an
executable proposal. Existing database workers retain their own authorization/locks.

Admission also locks and rechecks the workflow revision inside the existing database
transaction. This closes the race between Stop and the next queued operation. Background
coordination waits for the fixed queue-lock order; temporary admission unavailability
keeps the same saved request identity for the next poll. Failed or interrupted execution
receipts still require review and are never treated as transient admission failures.
