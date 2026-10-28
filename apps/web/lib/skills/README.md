# Saved instructions for a project

A Skill is a versioned set of instructions, such as “Use accessible forms and explain
validation errors.” Saving it in your private library does not run a model. A project
owner must select a particular saved version before new requests use it.

For example, editing your accessible-forms Skill creates a new version. A booking-app
build already in progress keeps the version selected when that request was accepted;
it does not change halfway through because the library changed.

- `contracts.ts` validates the browser-visible library, versions, project selections
  and save acknowledgements. It has no request client or server inference dependency.
- `client.ts` sends authenticated same-origin requests with a 20-second deadline.
  It validates acknowledgements with the requested schema. A schema is the expected
  shape of data, checked before the UI trusts it.
- `tests/unit` covers request cancellation, safe error handling and uncertain saves.

The settings library/editor live in `components/settings/skills`. Project selection
and the history of instructions used by a request live in `components/workspace`.
Only the API can decide who may read or change a selection. Loading a Skill never
starts inference; its text does not grant tools, networking or executable scripts.

An unconfirmed save may already exist on the server. The UI keeps the reviewed text
and request identity so the user can check/retry that same change. It must not clear
the editor or claim failure merely because a response was lost. A conflict is different:
the user reviews the current saved version before deciding what to change.

From the repository root:

```bash
bun test apps/web/lib/skills/tests/unit
```

Chrome acceptance in the API Skills module exercises import, exact retry, conflict
review, archive and viewer controls with local responses rather than model calls.
