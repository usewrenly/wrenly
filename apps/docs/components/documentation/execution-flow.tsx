// Ordered steps name the client/server and runtime transitions explicitly.
const flows = {
  publishing: [
    ["Choose a revision", "The owner selects one saved successful build."],
    [
      "Build an isolated image",
      "Wrenly freezes source and validates the runtime inside Docker.",
    ],
    [
      "Keep source and image private",
      "Gitea holds source; your registry holds the exact runtime image.",
    ],
    [
      "Run it with Coolify",
      "Coolify pulls that image digest and receives runtime secrets separately.",
    ],
    [
      "Verify the deployment",
      "Wrenly checks the remote job, routed HTTP response and deployment identity.",
    ],
  ],
  build: [
    [
      "Browser → Hono API",
      "The signed-in user sends a prompt with an explicit project and revision.",
    ],
    [
      "Authorize and admit",
      "The API checks project access and saves a durable request in PostgreSQL.",
    ],
    [
      "MCP client → framework MCP server",
      "The API calls a Next.js or Laravel generation/edit tool through MCP.",
    ],
    [
      "Server-side inference → generated source",
      "The saved provider/model and guidance produce framework-specific files.",
    ],
    [
      "Docker validation → bounded repair",
      "Install dependencies, block networking and validate; return errors for bounded repair attempts.",
    ],
    [
      "Persist results → browser replay",
      "The worker saves source, outcome and progress; the browser can reconnect independently.",
    ],
  ],
} as const;
export function ExecutionFlow({
  kind,
}: {
  kind: keyof typeof flows;
}): React.JSX.Element {
  const steps = flows[kind];
  if (!steps) throw new Error("Unknown documentation flow.");
  return (
    <figure
      className="docs-execution-flow not-prose"
      aria-label={
        kind === "build"
          ? "Prompt to saved revision flow"
          : "Saved revision to deployment flow"
      }
    >
      <ol>
        {steps.map(([title, detail], index) => (
          <li key={title}>
            <span className="docs-step-number">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div>
              <strong>{title}</strong>
              <p>{detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </figure>
  );
}
