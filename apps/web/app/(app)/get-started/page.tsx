"use client";
// Progress follows saved facts; optional features never block first use.
import Link from "next/link";
import { CheckIcon, ArrowUpRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSetupSummary } from "@/lib/onboarding/setup-summary";
export default function GetStartedPage(): React.JSX.Element {
  const { data, isPending, isError, error, refetch, isFetching } =
    useSetupSummary();
  const owner = data?.role === "owner";
  const steps = data
    ? [
        {
          id: "account",
          title: owner ? "Secure your instance" : "Your local account",
          complete: data.accountConfigured,
          description: !data.accountConfigured
            ? "Ask your operator to complete verified owner recovery using a private recovery link."
            : owner
              ? "Your owner account is ready."
              : "You are signed in to this Wrenly instance.",
        },
        {
          id: "provider",
          title: "Connect a model provider",
          complete: data.providerConfigured,
          description:
            "Use models on your server or connect a hosted provider.",
        },
        {
          id: "model",
          title: "Choose your default model",
          complete: data.defaultModel.state === "configured",
          description:
            data.defaultModel.state === "disabled"
              ? "The default connection is disabled. Enable it or choose another connection."
              : data.defaultModel.state === "unavailable"
                ? "The saved default needs attention. Review its connection settings."
                : data.defaultModel.state === "configured"
                  ? `${data.defaultModel.providerLabel} · ${data.defaultModel.modelId}`
                  : "A clear starting point for new conversations and builds.",
        },
        {
          id: "project",
          title: "Start your first project",
          complete: data.hasProjects,
          description: "Bring a brief. Plan it together, then build.",
        },
      ]
    : [];
  const next = steps.find((step) => !step.complete)?.id;
  const completed = steps.filter((step) => step.complete).length;
  return (
    <div className="setup-page">
      <header className="setup-intro">
        <p className="setup-eyebrow">A good foundation</p>
        <h1>Make this instance yours.</h1>
        <p>
          Connect your models, choose a default, and start your first project.
          <br />
          Take it one step at a time.
        </p>
      </header>
      {isPending && (
        <p role="status" className="setup-notice">
          Reading saved setup progress…
        </p>
      )}
      {isError && (
        <div role="alert" className="setup-notice">
          <p>{error.message}</p>
          <Button
            variant="outline"
            disabled={isFetching}
            onClick={() => {
              void refetch();
            }}
          >
            Try again
          </Button>
          <Link href="/sign-in">Sign in</Link>
        </div>
      )}
      {data && !isError && (
        <>
          <div className="setup-columns">
            <aside className="setup-progress">
              <h2>Your starting point</h2>
              <p className="setup-count">
                {completed}
                <span>/ {steps.length} essentials</span>
              </p>
              <div className="setup-progress-track" aria-hidden="true">
                <span
                  style={{ width: `${(completed / steps.length) * 100}%` }}
                />
              </div>
              <p>
                {completed === steps.length
                  ? "Your essentials are configured. Keep shaping your next idea."
                  : next === "provider"
                    ? "Next, choose how Wrenly connects to your models."
                    : next === "model"
                      ? "Next, choose a default for new requests."
                      : "Your next step is waiting on the right."}
              </p>
              <Link href="/">
                Explore your workspace <ArrowUpRightIcon />
              </Link>
            </aside>
            <div>
              <section
                className="setup-task-list"
                aria-label="Setup essentials"
              >
                {steps.map((step, index) => (
                  <div
                    key={step.id}
                    className="setup-task"
                    data-current={next === step.id}
                  >
                    <span
                      className="setup-step"
                      data-complete={step.complete}
                      aria-hidden="true"
                    >
                      {step.complete ? (
                        <CheckIcon />
                      ) : (
                        String(index + 1).padStart(2, "0")
                      )}
                    </span>
                    <div className="setup-task-content">
                      <h2>{step.title}</h2>
                      <p>{step.description}</p>
                      {next === step.id &&
                        (step.id === "provider" || step.id === "model") && (
                          <div className="setup-task-detail">
                            {owner ? (
                              <>
                                <p>
                                  Credentials stay encrypted on your instance.
                                  Connection checks are explicit; opening this
                                  page does not contact a model provider.
                                </p>
                                <Link
                                  className="setup-action"
                                  href="/settings/providers"
                                >
                                  {step.id === "provider"
                                    ? "Connect a provider"
                                    : "Choose a default"}
                                  <ArrowUpRightIcon />
                                </Link>
                              </>
                            ) : (
                              <p>
                                Ask your instance owner to configure shared
                                inference. You can choose an enabled model in{" "}
                                <Link href="/settings/models">model settings</Link>.
                              </p>
                            )}
                          </div>
                        )}
                      {next === step.id && step.id === "project" && (
                        <Link className="setup-action" href="/#new-project">
                          Start a project
                          <ArrowUpRightIcon />
                        </Link>
                      )}
                    </div>
                    <span className="setup-task-state">
                      {step.complete
                        ? "Complete"
                        : next === step.id
                          ? "Next step"
                          : "Not started"}
                    </span>
                  </div>
                ))}
              </section>
              <section className="setup-optional">
                <header>
                  <h2>When you’re ready to go further</h2>
                  <span className="setup-eyebrow">Optional</span>
                </header>
                <div>
                  <section>
                    <h3>Preview your work</h3>
                    <p>Run generated apps in an isolated local preview.</p>
                  </section>
                  <span>
                    {data.preview === "enabled"
                      ? "Enabled in configuration"
                      : "Operator setup"}
                  </span>
                </div>
                <div>
                  <section>
                    <h3>Publish privately</h3>
                    <p>
                      Promote a validated artifact to your deployment server.
                    </p>
                  </section>
                  <span>
                    {data.publishing === "enabled"
                      ? "Enabled in configuration"
                      : "Operator setup"}
                  </span>
                </div>
                {owner && (
                  <div>
                    <section>
                      <h3>Invite your team</h3>
                      <p>
                        Give members access with private invitations. Projects
                        remain private.
                      </p>
                    </section>
                    <Link href="/settings/access">
                      Manage access <ArrowUpRightIcon />
                    </Link>
                  </div>
                )}
              </section>
            </div>
          </div>
          <p className="setup-footnote">
            This page reads saved configuration; it does not test preview apps
            or deployments. Provider credentials and model access have not been
            tested by this page. A first project does not certify a successful
            build. Preview and publishing may need operator setup; they are
            optional.
          </p>
        </>
      )}
    </div>
  );
}
