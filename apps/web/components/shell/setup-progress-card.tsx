"use client";
// Same saved essentials as Get started; never a health score.
import Link from "next/link";
import { ArrowUpRightIcon } from "lucide-react";
import { useSetupSummary } from "@/lib/onboarding/setup-summary";
/** Shows persisted setup progress without extra service probes or browser-only completion flags. */
export function SetupProgressCard(): React.JSX.Element | null {
  const { data, isError } = useSetupSummary();
  if (!data || isError) return null;
  const completed = [
    data.accountConfigured,
    data.providerConfigured,
    data.defaultModel.state === "configured",
    data.hasProjects,
  ].filter(Boolean).length;
  if (completed === 4) return null;
  const canCreate =
    !data.hasProjects &&
    (data.providerConfigured || data.defaultModel.state === "configured");
  if (data.role !== "owner" && !canCreate) return null;
  const needsModel =
    data.role === "owner" &&
    (!data.providerConfigured || data.defaultModel.state !== "configured");
  const href = needsModel
    ? "/settings/providers"
    : canCreate
      ? "/#new-project"
      : "/get-started";
  const nextStep = needsModel
    ? "Connect your model"
    : canCreate
      ? "Start your first project"
      : "Finish account setup";
  return (
    <Link href={href} className="home-progress-card">
      <span className="home-progress-heading">
        <strong>Get started</strong>
        <ArrowUpRightIcon size={15} aria-hidden="true" />
      </span>
      <span className="home-progress-caption">
        {nextStep}
        <span>{completed}/4</span>
      </span>
      <span
        role="progressbar"
        aria-label="Configured setup essentials"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={completed}
        className="home-progress-track"
      >
        <span style={{ width: `${(completed / 4) * 100}%` }} />
      </span>
    </Link>
  );
}
