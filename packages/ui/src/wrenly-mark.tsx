import { BRAND_PATHS, BRAND_VIEW_BOX } from "./brand/artwork";

/** Shared, inline designer artwork keeps feather layers available to decorative CSS.
 * Both originals are retained because the dark version also changes the geometry.
 * Callers give meaningful labels to their enclosing link or button.
 */
export function WrenlyMark({ className = "", variant = "default" }: {
  className?: string;
  variant?: "default" | "on-primary";
}): React.JSX.Element {
  return (
    <svg viewBox={BRAND_VIEW_BOX} className={`wrenly-brand ${className}`}
      data-mark-variant={variant} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {(["light", "dark"] as const).map(mode => (
        <g key={mode} data-artwork={mode}>
          {BRAND_PATHS.map((path, index) => (
            <path key={index} data-feather={index + 1}
              d={mode === "dark" ? path.darkD : path.d} fill={path[mode]} fillOpacity={mode === "dark" ? path.darkOpacity : path.lightOpacity} />
          ))}
        </g>
      ))}
    </svg>
  );
}
