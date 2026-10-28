import { WrenlyMark } from "@/components/wrenly-mark";

/**
 * PURPOSE: Give access checks a recognisable waiting state without granting access.
 * INPUTS: The current operation's readable label.
 * OUTPUTS: A decorative feather animation and an accessible status message.
 * STEPS: Render the shared bird, then announce the label once as a status.
 * EDGE CASES: Reduced-motion preferences leave the bird still.
 * ERROR STATES: The calling guard keeps its existing retry and error controls.
 */
export function EntryLoading({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="entry-loading" role="status">
      <WrenlyMark className="entry-loading-mark wrenly-wing-motion" />
      <p>{label}</p>
    </div>
  );
}
