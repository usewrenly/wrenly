// Shared readable help with an explicit unconfigured state.
import { documentationHref } from "@/lib/documentation-url";
export function DocumentationLink({
  guide = "",
  children = "See docs →",
}: {
  guide?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const href = documentationHref(guide);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span title="Ask your instance operator to connect its documentation site.">
      Documentation is not connected
    </span>
  );
}
