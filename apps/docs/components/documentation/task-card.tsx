// Short task entry points share the product's icon/paper treatment.
import Link from "next/link";
import { DocumentationIcon, type DocumentationIconName } from "./icons";
export function TaskCard({
  title,
  description,
  href,
  icon,
}: {
  title: string;
  description: string;
  href: string;
  icon: DocumentationIconName;
}): React.JSX.Element {
  return (
    <Link className="docs-task-card not-prose" data-card href={href}>
      <span className="docs-icon-tile">
        <DocumentationIcon name={icon} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      <span className="docs-card-arrow" aria-hidden="true">
        ↗
      </span>
    </Link>
  );
}
export function StatusBadge({
  state,
  children,
}: {
  state: "implemented" | "development" | "planned";
  children: React.ReactNode;
}): React.JSX.Element {
  if (!["implemented", "development", "planned"].includes(state))
    throw new Error("Unknown documentation capability state.");
  return (
    <span className="docs-status" data-state={state}>
      {children}
    </span>
  );
}
