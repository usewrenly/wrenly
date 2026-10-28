// Semantic HTML diagrams remain readable offline and on narrow screens.
import { DocumentationIcon, type DocumentationIconName } from "./icons";
function Node({
  icon,
  title,
  detail,
  primary = false,
}: {
  icon: DocumentationIconName;
  title: string;
  detail: string;
  primary?: boolean;
}): React.JSX.Element {
  return (
    <div className="docs-diagram-node" data-primary={primary}>
      <DocumentationIcon name={icon} />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}
export function ArchitectureDiagram(): React.JSX.Element {
  return (
    <figure
      className="docs-diagram not-prose"
      aria-label="Wrenly system architecture"
    >
      <div className="docs-flow">
        <Node
          icon="users"
          title="Web workspace"
          detail="Next.js · browser UI"
        />
        <span className="docs-flow-arrow" aria-hidden="true">
          →
        </span>
        <Node
          primary
          icon="layers"
          title="Wrenly API"
          detail="Hono · Bun · Better Auth"
        />
        <span className="docs-flow-arrow" aria-hidden="true">
          ↔
        </span>
        <Node
          icon="sparkles"
          title="Framework MCP servers"
          detail="Next.js / Laravel tools"
        />
      </div>
      <p className="docs-diagram-connector">
        API-managed persistence and execution ↓
      </p>
      <div className="docs-diagram-branches">
        <Node
          icon="database"
          title="Control PostgreSQL"
          detail="Accounts · history · durable work"
        />
        <Node
          icon="shield"
          title="Docker sandbox"
          detail="Validation · isolated previews"
        />
        <Node
          icon="rocket"
          title="Publishing"
          detail="Private image → Coolify"
        />
      </div>
      <figcaption>
        The API calls framework tools through MCP. Model calls and credentials
        stay server-side. Browser subscriptions do not own execution.
      </figcaption>
    </figure>
  );
}
export function DatabaseDiagram(): React.JSX.Element {
  return (
    <figure
      className="docs-diagram not-prose"
      aria-label="Instance and generated-app databases"
    >
      <div className="docs-diagram-branches">
        <Node
          primary
          icon="database"
          title="Instance data"
          detail="Control PostgreSQL · active"
        />
        <Node
          icon="database"
          title="Generated-app data"
          detail="Experimental · Development only"
        />
      </div>
      <figcaption>
        These are separate resources and credentials. Generated applications
        never receive control-database access. Development uses its own scoped
        credentials; Production provisioning remains unavailable.
      </figcaption>
    </figure>
  );
}
