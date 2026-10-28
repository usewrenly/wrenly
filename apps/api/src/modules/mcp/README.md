# Calling framework tools

You ask Wrenly to “Add a booking calendar.” The build worker starts the framework's
MCP server, sends the request and receives files. **MCP is a standard way for programs
to offer and call tools.** Here, Wrenly is the client and the framework program is the
server. They exchange messages over the child process's input and output streams.

The model writes the answer. This module checks that answer and closes the process;
it does not run the generated application. Docker validation belongs to the sandbox.

## Where to look

| File | Responsibility |
| --- | --- |
| `agent-client.ts` | Select the framework program and resolve the saved model connection. |
| `mcp-generation.ts` | Connect, call the tool, enforce the deadline and confirm process exit. |
| `file-edits.ts` | Validate explicit changes and merge them into the selected saved revision. |
| `tests/unit` | File-change validation without a subprocess. |
| `tests/integration` | Real protocol calls with controlled local answers and process-lifetime checks. |
| `tests/fixtures` | Small programs used only by those checks. |

These three implementation files form one small boundary, so they stay together.
`AgentInput`, `AgentOutput` and `FileTree` have one definition in `agent-client.ts`.
Their names and the `*-agent` package names are compatibility identifiers.

## Updating an existing app

A new app uses the `generate_app` tool. A change to an existing app requires
`edit_app_v1` and the complete selected revision. For example, changing a heading
updates that file while keeping files the model did not mention. Deletion must be
explicit. Conflicting changes, unsafe paths and incomplete or oversized context fail
before a merged revision is returned. An unsupported server never falls back to
regenerating the whole app. Frozen project skills also require advertised support.

Saved model credentials enter a restricted subprocess environment, not the tool's
arguments. Bun servers disable automatic `.env` loading so unrelated local settings
cannot replace the selected connection. New framework support needs protocol, source,
sandbox and runtime verification; adding a command to the registry alone is insufficient.
Vue and Django registry entries do not establish release support.

## Stopping work and handling failures

One deadline covers connection and tool execution. Cancellation closes the connection
and the client confirms that its child process exited. A cleanup failure is reported
separately: the build executor must not treat a potentially running process as another
model repair. Servers must also exit when their parent closes input, including a hard
API crash.

The client bounds returned source text before parsing its JSON; this is not a claim
that every SDK protocol frame is bounded by that same source limit. Later build and
sandbox checks enforce artifact and execution policies independently.

From the repository root:

```bash
bun test apps/api/src/modules/mcp/tests/unit
WRENLY_TEST_MCP=true bun test apps/api/src/modules/mcp/tests/integration
```

Integration checks start local fixture HTTP servers and real MCP subprocesses. They
use fake model credentials and do not execute generated JavaScript/PHP or deploy apps.
