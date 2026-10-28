"use client";
//
// Dashboard — "What are we building?" + composer as the primary CTA.
// Submitting creates the project (POST /api/projects), parks the prompt
// in sessionStorage for the workspace to pick up, then routes there.

import type { ConversationMode } from "@/lib/conversations/contracts";
import {
  draftRequest,
  parseDraft,
  type ProjectDraft,
} from "@/lib/projects/drafts/project-drafts";
import { InitialProjectSkills } from "@/components/settings/skills/initial-project-skills";
import { apiFetch } from "@/lib/api";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth/auth-client";
import { useProjects } from "@/hooks/use-projects";
import { promptToTitle, relativeTime } from "@/lib/format";
import { useSetupSummary } from "@/lib/onboarding/setup-summary";
import { ProjectListError } from "@/hooks/use-projects";
import { Composer } from "@/components/workspace/composer";
import { StackBadge } from "@/components/shell/stack-badge";
import { StatusPill } from "@/components/shell/status-pill";
import { ArrowUpRightIcon } from "lucide-react";

const EXAMPLES = [
  "A landing page for a coffee subscription with pricing tiers",
  "A contacts dashboard with a CRUD table and search",
  "A personal finance tracker with monthly summary cards",
];

export function Dashboard(): React.JSX.Element {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const {
    data: projects = [],
    isPending,
    error: projectsError,
    refetch,
  } = useProjects();
  const setup = useSetupSummary();
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const [createdProject, setCreatedProject] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [skillVersionIds, setSkillVersionIds] = useState<string[]>([]);
  const [submissionError, setSubmissionError] = useState<string | null>(null);

  const [idea, setIdea] = useState<ProjectDraft | null>(null);
  const [ideaError, setIdeaError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search),
      id = params.get("draft"),
      revision = params.get("revision");
    if (!id) return;
    const abort = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const value = parseDraft(
          (
            await draftRequest(
              `/api/drafts/${encodeURIComponent(id)}`,
              undefined,
              abort.signal,
            )
          ).draft,
        );
        if (abort.signal.aborted) return;
        if (value.archivedAt)
          throw new Error("Restore this idea before using it as a prompt.");
        if (value.revision !== revision)
          throw new Error(
            "This draft changed. Reopen it and review the saved version before using it as a prompt.",
          );
        setIdea(value);
      } catch (failure) {
        if (!abort.signal.aborted)
          setIdeaError(
            failure instanceof Error
              ? failure.message
              : "Draft could not be loaded.",
          );
      }
    };
    void load();
    return () => abort.abort();
  }, []);
  const firstName = session?.user?.name?.split(" ")[0];

  const submit = async (
    prompt: string,
    stack: string,
    model?: string,
    provider?: string,
    mode: ConversationMode = "auto",
  ): Promise<boolean | void> => {
    if (submittingRef.current || createdProject) return false;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmissionError(null);
    try {
      const res = await apiFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: promptToTitle(prompt), stack, skillVersionIds }),
      });
      if (!res.ok) {
        const failure: unknown = await res.json();
        throw new Error(failure && typeof failure === "object" && "error" in failure && typeof failure.error === "string" ? failure.error : `Could not create project (${res.status})`);
      }
      const data: unknown = await res.json();
      if (
        !data ||
        typeof data !== "object" ||
        !("project" in data) ||
        !data.project ||
        typeof data.project !== "object" ||
        !("id" in data.project) ||
        typeof data.project.id !== "string"
      )
        throw new Error(
          "The project response could not be read. Refresh your projects before trying again.",
        );
      setCreatedProject(data.project.id);

      // The workspace consumes this on mount and admits the conversation turn. The
      // model choice rides along — dropping it here meant the dashboard
      // silently built with the env default no matter what was picked.
      sessionStorage.setItem(
        `wrenly:pending:${data.project.id}`,
        JSON.stringify({
          kind: "conversation",
          message: prompt,
          mode,
          baseBuildId: null,
          model,
          provider,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      router.push(`/p/${data.project.id}`);
    } catch (error) {
      submittingRef.current = false;
      setSubmitting(false);
      setSubmissionError(
        error instanceof Error
          ? error.message
          : "Could not create project. Try again.",
      );
      return false;
    }
  };

  const visibleProjects = [...projects]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 4);

  return (
    <div id="new-project" className="home-page">
      <section className="home-intro" aria-labelledby="home-heading">
        <p className="home-eyebrow">Your workspace, your next idea</p>
        <h1 id="home-heading">
          {firstName
            ? `What will you build, ${firstName}?`
            : "What will you build?"}
        </h1>
        <p className="home-description">
          Start with an idea. Shape it together. Make it yours.
        </p>
        {ideaError && (
          <p role="alert" className="home-notice">
            {ideaError}
          </p>
        )}
        {idea && (
          <section className="draft-handoff">
            <h2>{idea.title}</h2>
            <p>
              Review the saved idea, then load it into the prompt below. Choose
              a framework and model before sending. Nothing has started.
            </p>
            <pre>{idea.body || idea.title}</pre>
            {(idea.body || idea.title).length > 16000 ? (
              <p>
                This idea is longer than the prompt limit. Return to Drafts and
                prepare a version of at most 16,000 characters; the original is
                preserved.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraft({
                    id: crypto.randomUUID(),
                    text: idea.body || idea.title,
                  });
                  setIdea(null);
                }}
              >
                Use this saved draft
              </button>
            )}
            <Link href={`/projects/drafts/${idea.id}`}>Return to draft</Link>
          </section>
        )}
        <Composer
          onSubmit={submit}
          disabled={submitting || Boolean(createdProject)}
          draft={draft}
          projectTools={<InitialProjectSkills versionIds={skillVersionIds} onChange={setSkillVersionIds} disabled={submitting || Boolean(createdProject)} />}
          variant="home"
        />
        {submissionError && (
          <div role="alert" className="home-notice">
            <p>{submissionError}</p>
            {createdProject && (
              <Link href={`/p/${createdProject}`}>
                Open your created project to continue
              </Link>
            )}
          </div>
        )}
        <div className="home-examples" aria-label="Prompt ideas">
          {EXAMPLES.map((example, index) => (
            <button
              key={example}
              type="button"
              disabled={submitting || Boolean(createdProject)}
              onClick={() =>
                setDraft({ id: crypto.randomUUID(), text: example })
              }
            >
              <span className="home-eyebrow">0{index + 1}</span>
              <span>{example}</span>
              <ArrowUpRightIcon size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
        <p className="home-caption">
          Choose an idea to edit it. Nothing starts until you send.
        </p>
      </section>

      {setup.isPending ? (
        <p className="home-notice" role="status">
          Reading your setup…
        </p>
      ) : setup.isError ? (
        <div className="home-notice">
          <p>Setup guidance is unavailable.</p>
          <button type="button" onClick={() => void setup.refetch()}>
            Try again
          </button>
        </div>
      ) : setup.data && setup.data.defaultModel.state !== "configured" ? (
        <div className="home-notice">
          <div>
            <strong>
              {setup.data.defaultModel.state === "disabled"
                ? "Your default provider is disabled"
                : "Choose a default model"}
            </strong>
            <p>
              {setup.data.role === "owner"
                ? "Connect a provider and choose a model in settings, then return to your idea."
                : "Ask your instance owner to configure a default model, or select an available model above."}
            </p>
          </div>
          <Link
            href={
              setup.data.role === "owner"
                ? "/settings/providers"
                : "/get-started"
            }
          >
            {setup.data.role === "owner" ? "Set up models" : "View setup"}{" "}
            <ArrowUpRightIcon size={14} aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <div className="home-setup-link">
          <Link href="/get-started">
            Review instance setup{" "}
            <ArrowUpRightIcon size={14} aria-hidden="true" />
          </Link>
        </div>
      )}

      <section
        id="projects"
        className="home-projects"
        aria-labelledby="projects-heading"
      >
        <div className="home-section-heading">
          <div>
            <p className="home-eyebrow">Pick up where you left off</p>
            <h2 id="projects-heading">Recent projects</h2>
          </div>
          {!isPending && !projectsError && (
            <Link href="/projects">View all projects ({projects.length})</Link>
          )}
        </div>
        {isPending ? (
          <p className="home-empty" role="status">
            Loading your projects…
          </p>
        ) : projectsError ? (
          <div className="home-empty" role="alert">
            <p>{projectsError.message}</p>
            {projectsError instanceof ProjectListError &&
            projectsError.status === 401 ? (
              <Link href="/sign-in">Sign in again</Link>
            ) : (
              <button type="button" onClick={() => void refetch()}>
                Try again
              </button>
            )}
          </div>
        ) : projects.length === 0 ? (
          <div className="home-empty">
            <h3>A place for your next idea</h3>
            <p>
              Describe your first app above. Your projects and their history
              will appear here.
            </p>
          </div>
        ) : (
          <div className="home-project-list" data-continuation={projects.length > 4}>
            {visibleProjects.map((project) => (
              <div key={project.id} className="home-project-row">
                <Link href={`/p/${project.id}`} className="home-project-main">
                  <span className="home-project-icon">
                    <StackBadge stack={project.stack} />
                  </span>
                  <span className="home-project-name">
                    <strong>{project.name}</strong>
                    <span>Updated {relativeTime(project.updatedAt)}</span>
                  </span>
                  <StatusPill status={project.latestBuild?.status ?? "idle"} />
                  <ArrowUpRightIcon
                    className="home-project-arrow"
                    size={16}
                    aria-hidden="true"
                  />
                </Link>
                {project.latestBuild?.deployedUrl &&
                  /^https?:\/\//.test(project.latestBuild.deployedUrl) && (
                    <a
                      className="home-live-link"
                      href={project.latestBuild.deployedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open deployed app for ${project.name}`}
                    >
                      <ArrowUpRightIcon size={16} /> <span>Live app</span>
                    </a>
                  )}
              </div>
            ))}
          </div>
        )}
        {!isPending && !projectsError && projects.length > 4 && (
          <div className="home-project-continuation" aria-hidden="true" />
        )}
      </section>
    </div>
  );
}
