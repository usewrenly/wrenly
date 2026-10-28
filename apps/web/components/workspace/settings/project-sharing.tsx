"use client";
// Owner-reviewed sharing and model changes preserve request identity across uncertain saves.
import { useEffect, useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { ChoiceSelect } from "@/components/ui/choice-select";
import { useModels } from "@/lib/models/discovery";
import { ProfileAvatar } from "@/components/account/profile-avatar";
import { ProjectArchiveControls } from "./project-archive-controls";
import { ProjectSkills } from "./project-skills";
import { ProjectSettings } from "./project-settings";
type Role = "viewer" | "editor";
interface Person {
  userId: string;
  name: string;
  email: string;
  role?: Role;
  suspended?: boolean;
}
export interface ProjectSharingState {
  archivedAt?: string | null;
  mode: "private" | "selected" | "instance";
  revision: string;
  instanceRole: Role;
  capabilities: {
    role: "owner" | Role;
    read: boolean;
    contribute: boolean;
    manage: boolean;
    publish: boolean;
  };
  members?: Person[];
  eligible?: Person[];
  model: {
    connectionId: string;
    modelId: string;
    version: string;
    enabled: boolean;
  } | null;
}
interface FrozenChange {
  key: string;
  path: string;
  body: Record<string, unknown>;
}
/** Uses the same server policy for owner controls and collaborator read-only explanations. */
export function ProjectAccessSettings({
  projectId,
}: {
  projectId: string;
}): React.JSX.Element {
  const client = useQueryClient(),
    models = useModels();
  const [search, setSearch] = useState("");
  const [section, setSection] = useState<"general" | "collaboration">(
    "general",
  );
  const query = useQuery({
    queryKey: ["project-access", projectId, search],
    queryFn: async ({ signal }) => {
      const response = await apiFetch(
        `/api/projects/${projectId}/access?search=${encodeURIComponent(search)}`,
        { signal, cache: "no-store" },
      );
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "Project not found or your access has changed."
            : "Project access could not be loaded.",
        );
      return response.json() as Promise<ProjectSharingState>;
    },
    retry: false,
  });
  const [draft, setDraft] = useState<{
    mode: ProjectSharingState["mode"];
    instanceRole: Role;
    members: Array<{ userId: string; role: Role }>;
  } | null>(null);
  const [baseline, setBaseline] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [canRetry, setCanRetry] = useState(false),
    [modelValue, setModelValue] = useState("");
  const frozen = useRef<FrozenChange | null>(null),
    lock = useRef(false);
  const reviewRegion = useRef<HTMLDivElement>(null),
    reviewButton = useRef<HTMLButtonElement>(null),
    wasReviewing = useRef(false);
  useEffect(() => {
    if (review) reviewRegion.current?.focus();
    else if (wasReviewing.current) reviewButton.current?.focus();
    wasReviewing.current = review;
  }, [review]);
  const data = query.data;
  useEffect(() => {
    if (data && !baseline) {
      setBaseline(data.revision);
      setDraft({
        mode: data.mode,
        instanceRole: data.instanceRole,
        members: (data.members ?? []).map((person) => ({
          userId: person.userId,
          role: person.role ?? "viewer",
        })),
      });
      if (data.model)
        setModelValue(
          JSON.stringify([data.model.connectionId, data.model.modelId]),
        );
    }
  }, [data, baseline]);
  const refresh = async (): Promise<void> => {
    const result = await query.refetch();
    if (result.isError || !result.data)
      throw new Error("Project access could not be refreshed.");
    setBaseline(result.data.revision);
    setDraft({
      mode: result.data.mode,
      instanceRole: result.data.instanceRole,
      members: (result.data.members ?? []).map((person) => ({
        userId: person.userId,
        role: person.role ?? "viewer",
      })),
    });
    setModelValue(
      result.data.model
        ? JSON.stringify([
            result.data.model.connectionId,
            result.data.model.modelId,
          ])
        : "",
    );
    setReview(false);
    setUncertain(false);
    setCanRetry(false);
    frozen.current = null;
    await client.invalidateQueries({ queryKey: ["project", projectId] });
    await client.invalidateQueries({ queryKey: ["projects"] });
  };
  const send = async (change: FrozenChange): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    try {
      const response = await apiFetch(change.path as `/api/${string}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change.body),
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        if (response.status >= 500) throw new Error("unconfirmed");
        setNotice(
          typeof value === "object" && value && "error" in value
            ? String(value.error)
            : "The change was rejected. Reload and review.",
        );
        setReview(false);
        setUncertain(false);
        frozen.current = null;
        return;
      }
      setNotice("Project settings saved.");
      await refresh();
    } catch {
      frozen.current = change;
      setUncertain(true);
      setCanRetry(false);
      setNotice(
        "This change could not be confirmed. Check saved access before trying again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const check = async (): Promise<void> => {
    const pending = frozen.current;
    if (!pending || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const response = await apiFetch(
        `/api/projects/${projectId}/access/actions/${pending.key}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("unavailable");
      const result = (await response.json()) as {
        action: { savedRevision: string; currentRevision: string } | null;
      };
      if (result.action) {
        setNotice(
          result.action.savedRevision === result.action.currentRevision
            ? "The change was saved."
            : "The change was saved, but newer settings now exist. Review current access.",
        );
        await refresh();
      } else {
        setCanRetry(true);
        setNotice(
          "No saved action was found. You can retry this exact change or reload to review current settings.",
        );
      }
    } catch {
      setNotice(
        "Saved access could not be checked. Keep this page open and try checking again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const beginSharing = (): void => {
    if (!draft) return;
    const key = crypto.randomUUID();
    frozen.current = {
      key,
      path: `/api/projects/${projectId}/access`,
      body: {
        ...draft,
        members: draft.mode === "selected" ? draft.members : [],
        expectedRevision: baseline,
        requestId: key,
      },
    };
    setReview(true);
    setNotice("");
  };
  const beginModel = (): void => {
    try {
      const [connectionId, modelId] = JSON.parse(modelValue) as [
        string,
        string,
      ];
      const key = crypto.randomUUID();
      void send({
        key,
        path: `/api/projects/${projectId}/access/model`,
        body: {
          requestId: key,
          expectedRevision: baseline,
          connectionId,
          modelId,
        },
      });
    } catch {
      setNotice("Choose an available saved provider model.");
    }
  };
  if (query.isError)
    return (
      <div role="alert" className="project-sharing">
        <p>{query.error.message}</p>
        <button onClick={() => void query.refetch()}>Try again</button>
      </div>
    );
  if (!data || !draft)
    return (
      <div className="project-sharing" role="status">
        Loading project access…
      </div>
    );
  if (data.archivedAt && data.capabilities.role === "owner")
    return (
      <div className="project-settings-page">
        <a href={`/p/${projectId}`}>← Back to workspace</a>
        <header className="project-settings-heading">
          <h1>Archived project</h1>
          <p>
            Your source, history and sharing are preserved. Restore to make
            changes.
          </p>
        </header>
        <ProjectSkills projectId={projectId} />
        <ProjectArchiveControls projectId={projectId} />
      </div>
    );
  if (!data.capabilities.manage)
    return (
      <div className="project-sharing">
        <p className="home-eyebrow">Project settings</p>
        <h1>Shared with you.</h1>
        <p>
          Your role is {data.capabilities.role}. Only the project owner can
          change details, sharing and the project model.
        </p>
        <a href={`/p/${projectId}`}>Back to workspace →</a>
        <ProjectSkills projectId={projectId} />
      </div>
    );
  const people = new Map(
    [...(data.eligible ?? []), ...(data.members ?? [])].map((person) => [
      person.userId,
      person,
    ]),
  );
  const savedModels = (models.data?.models ?? []).flatMap((model) => {
    const parts = model.provider.split(":");
    const id =
      parts[0] === "saved"
        ? parts[1]
        : /^[a-f0-9-]{36}$/.test(model.provider)
          ? model.provider
          : undefined;
    return id
      ? [
          {
            value: JSON.stringify([id, model.id]),
            label: model.label,
            description:
              models.data?.providers.find(
                (provider) => provider.id === model.provider,
              )?.label ?? model.provider,
          },
        ]
      : [];
  });
  const blocked = busy || uncertain || review;
  return (
    <div className="project-sharing-page">
      <ProjectSettings
        projectId={projectId}
        combined
        archiveBlocked={
          blocked ||
          draft.mode !== data.mode ||
          draft.instanceRole !== data.instanceRole ||
          (draft.mode === "selected" &&
            JSON.stringify(
              [...draft.members].sort((a, b) =>
                a.userId.localeCompare(b.userId),
              ),
            ) !==
              JSON.stringify(
                (data.members ?? [])
                  .map((person) => ({
                    userId: person.userId,
                    role: person.role,
                  }))
                  .sort((a, b) => a.userId.localeCompare(b.userId)),
              )) ||
          Boolean(
            modelValue &&
            data.model &&
            modelValue !==
              JSON.stringify([data.model.connectionId, data.model.modelId]),
          )
        }
        section={section}
        onSectionChange={setSection}
        accessLabel={
          data.mode === "private"
            ? "Private · only you"
            : data.mode === "selected"
              ? "Selected members"
              : "Everyone in this instance"
        }
      />
      <section
        hidden={section !== "collaboration"}
        id="project-collaboration"
        className="project-sharing"
      >
        <p className="home-eyebrow">Access & inference</p>
        <h2 className="project-collaboration-title">Collaboration</h2>
        <p>
          Choose who can join this project. Sharing includes its existing
          conversations, source, revisions and logs.
        </p>
        <div className="project-sharing-panel">
          <h2>Project access</h2>
          <fieldset disabled={blocked}>
            <legend className="sr-only">Project visibility</legend>
            <div className="project-sharing-modes">
              {(["private", "selected", "instance"] as const).map((mode) => (
                <label key={mode}>
                  <input
                    type="radio"
                    name="project-visibility"
                    checked={draft.mode === mode}
                    onChange={() => setDraft({ ...draft, mode })}
                  />
                  <span>
                    {mode === "private"
                      ? "Private"
                      : mode === "selected"
                        ? "Selected members"
                        : "Everyone in this instance"}
                    <small>
                      {mode === "private"
                        ? "Only you"
                        : mode === "selected"
                          ? "People you choose"
                          : "Includes future accepted members"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {draft.mode === "instance" && (
            <ChoiceSelect
              label="Everyone’s project role"
              value={draft.instanceRole}
              disabled={blocked}
              onChange={(value) =>
                setDraft({ ...draft, instanceRole: value as Role })
              }
              options={[
                { value: "viewer", label: "Viewer — read only" },
                { value: "editor", label: "Editor — prompt and build" },
              ]}
            />
          )}
          {draft.mode === "selected" && (
            <>
              <label className="project-sharing-search">
                Find a member
                <input
                  type="search"
                  value={search}
                  disabled={blocked}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name or email"
                />
              </label>
              <ChoiceSelect
                label="Add a project member"
                value=""
                disabled={blocked || draft.members.length >= 128}
                onChange={(value) => {
                  if (
                    value &&
                    !draft.members.some((person) => person.userId === value)
                  )
                    setDraft({
                      ...draft,
                      members: [
                        ...draft.members,
                        { userId: value, role: "viewer" },
                      ],
                    });
                }}
                options={(data.eligible ?? [])
                  .filter(
                    (person) =>
                      !draft.members.some(
                        (selected) => selected.userId === person.userId,
                      ),
                  )
                  .map((person) => ({
                    value: person.userId,
                    label: person.name,
                    description: person.email,
                  }))}
                displayValue="Add a member"
              />
              {draft.members.map((person) => (
                <div className="project-sharing-person" key={person.userId}>
                  <ProfileAvatar
                    name={people.get(person.userId)?.name ?? "Member"}
                    className="project-sharing-avatar"
                  />
                  <div className="project-sharing-identity">
                    <strong>
                      {people.get(person.userId)?.name ?? "Selected member"}
                    </strong>
                    <small>
                      {people.get(person.userId)?.email ?? person.userId}
                      {people.get(person.userId)?.suspended
                        ? " · Suspended"
                        : ""}
                    </small>
                  </div>
                  <ChoiceSelect
                    label={`Role for ${people.get(person.userId)?.name ?? person.userId}`}
                    value={person.role}
                    disabled={blocked}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        members: draft.members.map((item) =>
                          item.userId === person.userId
                            ? { ...item, role: value as Role }
                            : item,
                        ),
                      })
                    }
                    options={[
                      { value: "viewer", label: "Viewer" },
                      { value: "editor", label: "Editor" },
                    ]}
                  />
                  <button
                    disabled={blocked}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        members: draft.members.filter(
                          (item) => item.userId !== person.userId,
                        ),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </>
          )}
          <p className="project-sharing-note">
            Editors can use the project model and run builds. Publishing and
            access settings remain yours. Reducing access waits for active
            project work to finish.
          </p>
          {!review && (
            <button
              className="project-sharing-primary"
              disabled={blocked}
              ref={reviewButton}
              onClick={beginSharing}
            >
              Review access change →
            </button>
          )}
          {review && (
            <div
              role="region"
              aria-label="Review project access"
              ref={reviewRegion}
              tabIndex={-1}
              className="project-sharing-review"
            >
              <strong>Confirm project access</strong>
              <p>
                {draft.mode === "private"
                  ? "Only you will have access."
                  : draft.mode === "instance"
                    ? `All current and future accepted members will have ${draft.instanceRole} access.`
                    : `${draft.members.length} selected members will have access.`}{" "}
                Existing conversations, source, revisions and logs are included.
                Existing preview sessions will be revoked.
              </p>
              <button
                className="project-sharing-primary"
                disabled={busy}
                onClick={() => {
                  if (frozen.current) void send(frozen.current);
                }}
              >
                Confirm access
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setReview(false);
                  frozen.current = null;
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
        <div className="project-sharing-panel">
          <h2>Project model</h2>
          <p>
            Editors use this model. Credentials stay on your instance. Private
            projects keep your browser preferences.
          </p>
          <div className="project-model-controls">
            <ChoiceSelect
              label="Project model"
              value={modelValue}
              disabled={blocked}
              onChange={setModelValue}
              options={savedModels}
              displayValue={
                savedModels.find((model) => model.value === modelValue)
                  ?.label ??
                data.model?.modelId ??
                "Choose a saved provider model"
              }
            />
            <button
              className="project-sharing-primary"
              disabled={blocked || !modelValue}
              onClick={beginModel}
            >
              Save project model
            </button>
          </div>
          <p className="project-sharing-note">
            Environment providers need the existing dashboard import first. Ask
            the instance administrator if a saved connection is missing.
          </p>
        </div>
        {notice && (
          <div
            role={uncertain ? "alert" : "status"}
            className="project-sharing-feedback"
          >
            <p>{notice}</p>
            {uncertain && (
              <>
                <button disabled={busy} onClick={() => void check()}>
                  Check saved access
                </button>
                {canRetry && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (frozen.current) void send(frozen.current);
                    }}
                  >
                    Retry this exact change
                  </button>
                )}
              </>
            )}
            <button
              disabled={busy}
              onClick={() => {
                void refresh().catch(() =>
                  setNotice(
                    "Current access could not be refreshed. Try again.",
                  ),
                );
              }}
            >
              Reload and review
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
