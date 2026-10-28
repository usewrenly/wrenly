# Asking an AI model for an answer

**Inference means asking an AI model to produce an answer.** In Wrenly, that answer
might be an explanation, a plan or generated code. The package name
`@wrenly/inference` uses the usual technical term for this step.

For example:

> You type “Build a booking app” → Wrenly sends instructions to your chosen model →
> the model returns an answer.

This package checks where that request may go, sends it using the selected credentials,
limits its size and duration, and reports failures safely. The API chooses the model
and checks the user's permissions. Docker builds and runs generated apps; publishing
puts them online. Those are separate steps.

## Find the code

```text
src/
  network/destination.ts     Checks whether the model server's address is allowed
  network/transport.ts       Sends the request and receives the answer
  guidance/skill-guidance.ts Checks the saved project instructions sent with it
  index.ts                  Exports the functions and types used by other packages
tests/
  unit/                     Checks rules without calling a model
  integration/              Checks real HTTP using local fake model servers
```

The API and the Next.js/Laravel MCP servers use this same package. An MCP server is
the framework-specific program that exposes generation tools to Wrenly.

## Send credentials only to the intended server

A **model provider** runs the service that answers model requests. It might be Ollama
on your server or a hosted service. Its **endpoint** is the URL Wrenly connects to.

The address rules distinguish local/private servers from public hosted services.
They reject cloud metadata addresses and other reserved destinations. Hosted services
require HTTPS. An unexpected setting is rejected rather than guessed.

DNS translates a hostname into IP addresses. Wrenly checks every returned address,
then connects to one of those checked addresses. This is called **DNS pinning**: it
prevents another lookup from sending credentials somewhere different. HTTPS still
checks the original hostname. Redirects are refused for the same reason.

`createInferenceFetch` is a Fetch-compatible function used by the model SDK. Here,
**transport** simply means the code that sends and receives the HTTP request.
It supports only non-streaming `POST chat/completions`: Wrenly receives the complete
answer rather than forwarding tokens one at a time.

Requests and responses have an 8 MiB limit. A deadline limits the wait, including DNS
and upload reading; cancellation stops waiting and closes the HTTP request. Native DNS
may finish internally after cancellation, but its late answer cannot start a request.
Errors from the provider are replaced with safe messages so echoed secrets stay private.

## Keep the instructions that were selected

A project **skill** is saved guidance such as “use our team's coding style.” When work
is submitted, Wrenly saves the selected skill version with it. We call that a **frozen
snapshot**: later changes to the skill library do not change instructions for that work.

`FrozenSkill` and `SkillGuidance` describe this saved data. The parser checks its fields,
IDs, size, duplicates and content hash. A hash is a fingerprint used to detect changed
text. Other packages import these types instead of inventing their own versions.

Skill text is user-written guidance. It cannot grant tools, browsing, network access
or permission to override system, planning or sandbox rules.

## Check a change

From the repository root:

```bash
bun test packages/inference/tests/unit
bun run --cwd packages/inference check-types
WRENLY_TEST_PROVIDER_PROBE=true bun test packages/inference/tests/integration
```

The HTTP tests use local fake servers and tokens. They test connection rules, limits
and cancellation—not whether a real provider account can use a particular model.

## Shared file-edit contract

When you ask to change a heading, both framework servers use the same rules for
receiving the complete saved revision and returning explicit file changes.
`src/contracts/edit-contract.ts` owns these types and validators. Framework prompts
stay in their own packages; Laravel's version check also stays with Laravel.
The API separately checks and merges returned operations against the saved revision.
Importing this contract does not contact a model or execute generated files.

Run `bun test packages/inference/tests/unit/edit-contract.test.ts` from the root.
