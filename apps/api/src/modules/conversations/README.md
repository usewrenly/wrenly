# Conversations that remember what happened

A conversation is the messages you exchange with Wrenly. A **turn** is one submitted
message and the response or build action that follows it. A revision is a saved app
version you can select before asking for a change.

For example:

> Ask “Why did this build fail?” → Wrenly answers from saved evidence.
> Then ask “Fix that error” with the revision selected → Wrenly can start a build.
> Refresh the browser → the messages and build result are still there.

## Find the code

```text
contracts/       Message inputs, modes and allowed model decisions
persistence/     Saved turns/messages, ownership and authorized history/progress
execution/       Context, model decisions, build actions and worker loops
http/            Admission, history, progress subscriptions and cancellation
tests/unit/      Rules and worker/HTTP behavior with controlled services
tests/browser/   Workspace/controllers and presentation with local fake responses
```

The shared types live with the contract or saved-work store that owns them. Import
those definitions; do not create a second interpretation of a turn in another module.

## Answer, clarify or build

Auto can answer a question, ask for clarification or propose a build for a clear change
request. Plan discusses and revises a plan; it cannot propose execution. Switching back
to Auto does not send a message or execute the plan. A new explicit request is needed.
Historical Ask/Build modes remain supported for old saved records, not new composer choices.

The model returns a structured decision, checked against the saved mode. Model text
cannot choose project IDs, credentials, source revisions or provider settings. Those
come from the request Wrenly already authorized and saved.

## A plan is not a completed build

For a build proposal, the assistant proposal, action link and queued build are saved
in one database **transaction**—all succeed together, or none do. The build uses the
actual submitting actor and the selected source/model/skill versions, not a guessed
latest revision or an impersonated project owner.

The conversation waits for that build's saved outcome. **Reconciliation** means reading
what happened to the existing action, not asking the model again or starting another
build. Failed or interrupted work must not become an invented success summary.

## Be honest about the evidence

The conversation model receives saved messages, selected revision status, filenames and
limited diagnostics. It does not receive full source bodies for answering questions.
It must not claim to have inspected package contents or run commands from filenames alone.
Missing/truncated evidence is labelled; history that cannot fit the supported budget
fails explicitly rather than quietly dropping essential context.

Actual editing is a separate build/MCP path with complete selected source. Skills are
saved instruction snapshots and remain subordinate to system/source/Plan/security rules.

## Refresh is observation, not execution

**Admission** checks and saves one submitted turn using a unique request identity. A
**worker** picks it up and holds a **claim/lease**, meaning exclusive update ownership
that expires without renewal. Lost ownership prevents stale writes. Crashed model work
is interrupted, not silently sent again.

Browser progress subscriptions only read saved events. Closing one does not cancel
work; explicit cancellation has its own authorized path. History and later replay reads
recheck current project access and never return private claim/credential data.

## Check a change

```bash
bun test apps/api/src/modules/conversations/tests/unit
bun run --cwd apps/api check-types
bun run --cwd apps/api lint
bun run --cwd apps/api build
```

Separate disposable PostgreSQL fixtures verify turns, atomic actions and execution.
Browser tests use real controllers with controlled replies. These checks do not make a
real model call, publish an app or validate the framework MCP process/sandbox boundary;
those have their own acceptance tests. Never use an instance database for fixtures.


## Building an app with saved records

“Build a notes app that remembers notes” can return a database proposal in Auto. The
owner approves it in the conversation. `database-workflow/` then follows existing saved
resource operations and admits one build after the exact resource is ready. Migration
0049 stores that next-step state; no browser connection owns execution.

A second approval presents the generated migration files before verified backup,
disposable rehearsal and persistent application. Plan cannot save executable proposals.
Stop prevents later phases; sign-out, suspension and project/resource changes prevent
stale approval from authorizing more work. Unknown execution outcomes remain blocked.
The workflow reuses database workers rather than implementing another SQL executor.

`packages/db` exports the shared card contract without exporting the control client.
Browser reads receive bounded status/review data, never the approving session or saved
credentials. `database-workflow/DESIGN.md` explains the transaction boundary. Production
publishing remains a separate explicitly configured and approved operation.
