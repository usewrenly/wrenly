"use client";
// Opening this observer never starts work; it displays recorded execution steps.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { parseBuildActivity, type BuildActivity } from "@/lib/builds/build-activity";
const POLL_MS = 2000;
class ActivityAccessError extends Error {}
const OPERATION_LABELS = {
  generation: "Generate source",
  source: "Receive source files",
  installation: "Install dependencies",
  validation: "Validate with network disabled",
};
export function ExecutionActivity({
  buildId,
  active,
}: {
  buildId: string;
  active: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const activity = useQuery<{ events: BuildActivity[]; running: boolean }>({
    queryKey: ["build-activity", buildId],
    enabled: open || active,
    retry: false,
    refetchInterval: (query) =>
      (open || active) && (active || query.state.data?.running)
        ? POLL_MS
        : false,
    queryFn: async ({
      signal,
    }): Promise<{ events: BuildActivity[]; running: boolean }> => {
      try {
        const response = await apiFetch(`/api/builds/${buildId}/activity`, {
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        });
        if ([401, 403, 404].includes(response.status))
          throw new ActivityAccessError(
            "Execution activity is no longer accessible. Check your project access.",
          );
        if (!response.ok)
          throw new Error("Execution activity could not be loaded.");
        const value: unknown = await response.json();
        if (
          !value ||
          typeof value !== "object" ||
          !("buildId" in value) ||
          value.buildId !== buildId ||
          !("cursor" in value) ||
          !Number.isSafeInteger(value.cursor)
        )
          throw new Error("Invalid execution activity.");
        const events = parseBuildActivity(
          "activity" in value ? value.activity : undefined,
        );
        if (events.some((event) => event.sequence > Number(value.cursor)))
          throw new Error("Activity is ahead of its saved revision.");
        const outcome = "outcome" in value ? value.outcome : null;
        if (
          outcome !== null &&
          ![
            "queued",
            "running",
            "success",
            "failed",
            "cancelled",
            "interrupted",
          ].includes(String(outcome))
        )
          throw new Error("Invalid execution outcome.");
        return {
          events,
          running: outcome === "queued" || outcome === "running",
        };
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error("Execution activity is unavailable.");
      }
    },
  });
  const steps = new Map<string, BuildActivity>();
  for (const event of activity.data?.events ?? [])
    steps.set(`${event.attempt}:${event.operation}`, event);
  return (
    <details
      className="execution-activity"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {activity.isError
          ? "Execution activity unavailable — Details"
          : active && activity.data?.events.length
            ? `${OPERATION_LABELS[activity.data.events[activity.data.events.length - 1]!.operation]} · ${activity.data.events[activity.data.events.length - 1]!.state} — Execution steps`
            : "Execution steps"}
      </summary>
      {open && activity.isError && (
        <div role="alert">
          <p>{activity.error.message}</p>
          <button onClick={() => void activity.refetch()}>Try again</button>
          {steps.size > 0 &&
          !(activity.error instanceof ActivityAccessError) ? (
            <p>
              Previously recorded steps are shown below. Current progress is
              unconfirmed.
            </p>
          ) : null}
        </div>
      )}
      {open &&
        !(activity.error instanceof ActivityAccessError) &&
        (!activity.isError || steps.size > 0) &&
        (activity.isPending ? (
          <p role="status">Loading saved activity…</p>
        ) : !steps.size ? (
          <p>
            Detailed steps were not recorded for this build. Its result and logs
            remain available.
          </p>
        ) : (
          <ol>
            {[...steps].map(([key, event]) => (
              <li key={key} data-state={event.state}>
                <span className="execution-step-state">
                  {event.state === "completed"
                    ? "Done"
                    : event.state === "failed"
                      ? "Failed"
                      : activity.data?.running && !activity.isError
                        ? "Started"
                        : "Unconfirmed"}
                </span>
                <div>
                  <strong>{OPERATION_LABELS[event.operation]}</strong>
                  <span>
                    Attempt {event.attempt} ·{" "}
                    <time dateTime={event.occurredAt}>
                      {new Date(event.occurredAt).toLocaleTimeString()}
                    </time>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        ))}
    </details>
  );
}
