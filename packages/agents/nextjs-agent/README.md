# Next.js MCP server

You ask Wrenly to “Build a team directory.” This package sends framework-specific
instructions to your selected model and returns application files. It does not run
those files or deploy the app. The API calls its tools through MCP: a standard way
for one program to ask another program to perform a named operation.

## Finding the code

- `src/server.ts` exposes tools over the process input/output pipes and returns safe errors.
- `src/index.ts` builds model messages and parses generated source.
- `src/edit-prompt.ts` contains framework-specific editing instructions.
- `@wrenly/inference` owns shared edit types, validation and their unit tests.

A revision is a saved set of files. An edit returns only explicit changes; the API
keeps files that were not mentioned. A repair attempt includes previous build errors
so the model can correct them. The API owns retries; the model SDK does not retry on
its own. Initial generation rejects unfinished answers and bounds response text.


`@wrenly/nextjs-agent` is the compatibility package name for Wrenly's Next.js
MCP server. It exposes generation/editing tools over stdio; the API calls those
tools rather than importing the generator implementation.

## Tools

- `generate_app`: prompt, prior errors and attempt → complete `{files:[{path,content}]}`.
  Targets Next.js 15 App Router, TypeScript, React 19 and Tailwind using the existing
  generation instructions. Output still requires Docker validation.
  New generation explicitly targets Tailwind 3.4 with Tailwind/PostCSS configuration,
  global directives and root-layout CSS import; installing Tailwind alone is insufficient.
- `edit_app_v1`: `{version:1,prompt,files,previousErrors,attempt}` →
  `{version:1,operations:[...]}`. Each operation is `create` or `update` with path
  and complete content, or `delete` with a path. Omitted files remain unchanged
  when the API merges the result. Duplicate/conflicting and unsafe paths fail.

Editing receives the complete frozen source snapshot, limited to 128,000 serialized
bytes and 1,000 files. It never truncates a file silently. Full replacement content
is required for updated files. Larger revisions need future context/retrieval work;
provider token windows are a separate constraint. Editing SDK requests disable
automatic retries; the API's bounded build-attempt loop owns repair.

The orchestrator discovers `edit_app_v1` before editing. Servers without that tool
fail explicitly rather than falling back to full regeneration. MCP errors expose
safe structured codes (`invalid_edit_input`, `invalid_edit_output`, `edit_model_error`),
plus `invalid_edit_json`, `edit_response_truncated` and `edit_response_unfinished`,
without provider bodies or stack traces. The server exits on stdin EOF so an API
crash cannot leave its inference subprocess running.

## Configuration and checks

The API passes `WRENLY_MODEL_BASE_URL`, `WRENLY_MODEL_API_KEY` and
`WRENLY_MODEL_NAME` through a restricted server environment. Direct development
uses the existing defaults in src/index.ts. No provider key is a tool argument.

Run `bun run check-types` here and `bun test` at the repository root. Explicit
`WRENLY_TEST_MCP=true` tests under apps/api/src/modules/mcp exercise the real stdio
server with a trusted local model-response fixture; they do not call a real model
or execute generated application code. Sandbox validation remains a separate gate.

Known limits: no arbitrary code execution tools, no source-file retrieval tool,
no provider-specific token budgeting/compaction yet, and no guarantee that a model's
semantically incorrect edit will be caught by compilation alone. Package lint reuses the shared API TypeScript configuration.

## Project Skills input

Both tools advertise optional `skills_v1` using `SKILL_GUIDANCE_SCHEMA` from
`@wrenly/inference`. It carries immutable reviewed documents, version IDs and hashes;
`parseSkillGuidance` rejects invalid/oversized data. Generated and edited prompts keep
this user-authored guidance subordinate to system/source/security policy. It grants no
tools, browsing or network permission. Editing counts guidance against its context
budget and never truncates the source to make it fit. Repair uses the admitted snapshot.

New framework implementations should reuse this shared contract and advertise version1
explicitly. The MCP client refuses selected skills when the server lacks that capability;
never silently discard guidance or read the current user's library inside a stack server.
