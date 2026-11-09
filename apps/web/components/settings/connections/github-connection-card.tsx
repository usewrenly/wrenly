"use client";
/** Browser account setup uses server-issued redirects; credentials stay in the API. */
import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import { ArrowUpRightIcon, CheckIcon } from "lucide-react";
import { parseSourceConnectionStatus } from "@wrenly/source-control";
import { authClient } from "@/lib/auth/auth-client";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DocumentationLink } from "@/components/documentation-link";
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
async function result(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      record(value) && typeof value.error === "string"
        ? value.error
        : "Connection could not be checked.",
    );
  return value;
}
/** Account-scoped query keys avoid showing a former signed-in user's connection after switching accounts. */
export function GitHubConnectionCard(): React.JSX.Element {
  const { data: session } = authClient.useSession();
  return (
    <PersonalGitHubConnection
      key={session?.user.id ?? "signed-out"}
      userId={session?.user.id}
    />
  );
}
function PersonalGitHubConnection({
  userId,
}: {
  userId: string | undefined;
}): React.JSX.Element {
  const query = useSearchParams();
  const outcome = query.get("github");
  const [allowOtherAccounts, setAllowOtherAccounts] = useState(false);
  const [name, setName] = useState("Wrenly studio");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const status = useQuery({
    queryKey: ["source-github", userId],
    enabled: Boolean(userId),
    retry: false,
    queryFn: async () =>
      parseSourceConnectionStatus(
        await result(
          await apiFetch("/api/source/github", {
            signal: AbortSignal.timeout(15000),
          }),
        ),
      ),
  });
  const [repositories, setRepositories] = useState<string[] | null>(null);
  async function act(run: () => Promise<void>): Promise<void> {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Connection request failed. Reload its status before trying again.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function begin(action: "register" | "connect"): Promise<void> {
    await act(async () => {
      const value = await result(
        await apiFetch("/api/source/github/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify(
            action === "register"
              ? { action, name, allowOtherAccounts }
              : { action },
          ),
        }),
      );
      if (!record(value) || typeof value.url !== "string")
        throw new Error("GitHub setup response could not be read.");
      const url = new URL(value.url);
      if (url.origin !== "https://github.com" || url.username || url.password)
        throw new Error("GitHub setup address could not be verified.");
      if (
        value.kind === "registration" &&
        url.pathname === "/settings/apps/new" &&
        record(value.manifest)
      ) {
        const form = document.createElement("form"),
          input = document.createElement("input");
        form.method = "POST";
        form.action = url.href;
        input.type = "hidden";
        input.name = "manifest";
        input.value = JSON.stringify(value.manifest);
        form.append(input);
        document.body.append(form);
        form.submit();
        form.remove();
      } else if (
        value.kind === "authorization" &&
        url.pathname === "/login/oauth/authorize"
      )
        window.location.assign(url.href);
      else throw new Error("GitHub setup action could not be verified.");
    });
  }
  async function disconnect(): Promise<void> {
    await act(async () => {
      if (!status.data?.connection) return;
      await result(
        await apiFetch("/api/source/github/disconnect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ version: status.data.connection.version }),
        }),
      );
      setRepositories(null);
      await status.refetch();
    });
  }
  async function checkRepositories(): Promise<void> {
    await act(async () => {
      const value = await result(
        await apiFetch("/api/source/github/repositories", {
          signal: AbortSignal.timeout(35000),
        }),
      );
      if (
        !record(value) ||
        !Array.isArray(value.repositories) ||
        value.repositories.length > 200
      )
        throw new Error("Repository access could not be read.");
      const names = value.repositories.map((item: unknown) => {
        if (
          !record(item) ||
          typeof item.owner !== "string" ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(item.owner) ||
          typeof item.name !== "string" ||
          !/^[A-Za-z0-9_.-]{1,100}$/.test(item.name)
        )
          throw new Error("Repository access could not be read.");
        return `${item.owner}/${item.name}`;
      });
      setRepositories(names);
    });
  }
  const current = status.data;
  return (
    <article className="connection-card">
      <Image src="/connectors/github.svg" alt="" width={24} height={24} />
      <div className="min-w-0 flex-1 space-y-4">
        <div>
          <h2>GitHub</h2>
          <span className="connection-state">
            {status.isPending
              ? "Checking connection…"
              : current?.connection
                ? `Connected · ${current.connection.login}`
                : "Project source"}
          </span>
        </div>
        <p>
          Connect your GitHub account and choose the repositories this instance
          can access. Each member uses their own connection.
        </p>
        {outcome === "registered" ? (
          <p role="status">
            GitHub App registered. Now connect your account and choose
            repository access.
          </p>
        ) : null}
        {outcome === "connected" ? (
          <p role="status">
            <CheckIcon size={14} className="inline" aria-hidden="true" /> Your
            GitHub account is connected.
          </p>
        ) : null}
        {outcome === "failed" ? (
          <p role="alert">
            GitHub setup did not complete. Check the connection below before
            starting again.
          </p>
        ) : null}
        {status.isError ? (
          <div role="alert">
            <p>
              Connection status is unavailable. Apply the latest database
              migrations if this instance was just updated.
            </p>
            <Button variant="outline" onClick={() => void status.refetch()}>
              Reload connection
            </Button>
          </div>
        ) : null}
        {current && !current.app ? (
          current.canRegister ? (
            <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
              <h3 className="font-medium">01 · Register this instance</h3>
              <p className="text-sm text-muted-foreground">
                Create a GitHub App once for this Wrenly instance. GitHub will
                ask you to confirm its name and source permissions.
              </p>
              <label className="block space-y-2">
                <span className="text-sm">GitHub App name</span>
                <Input
                  value={name}
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowOtherAccounts}
                  onChange={(event) =>
                    setAllowOtherAccounts(event.target.checked)
                  }
                  disabled={busy}
                />
                Allow members to install this App on their own GitHub accounts.
                This makes the App registration public, not your repositories or
                Wrenly instance.
              </label>
              <Button
                disabled={busy || name.trim().length < 3}
                onClick={() => void begin("register")}
              >
                Register on GitHub <ArrowUpRightIcon size={14} />
              </Button>
            </div>
          ) : (
            <p>
              The instance owner needs to register its GitHub App before you can
              connect your account.
            </p>
          )
        ) : null}
        {current?.app ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              {!current.connection || current.connection.needsAuthorization ? (
                <Button disabled={busy} onClick={() => void begin("connect")}>
                  {current.connection ? "Authorize again" : "Connect GitHub"}{" "}
                  <ArrowUpRightIcon size={14} />
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void checkRepositories()}
                >
                  Check repository access
                </Button>
              )}
              {current.connection && !current.connection.needsAuthorization && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void begin("connect")}
                >
                  Reconnect
                </Button>
              )}
              <a
                className="text-sm underline underline-offset-4"
                href={`https://github.com/apps/${current.app.slug}/installations/new`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Choose repositories on GitHub ↗
              </a>
              {current.connection ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Select repositories in GitHub, then return here to check access.
              Disconnecting here removes local access; uninstalling the App is
              managed in GitHub.
            </p>
          </div>
        ) : null}
        {repositories ? (
          <div className="rounded-xl border border-border p-4">
            <h3 className="text-sm font-medium">Repository access</h3>
            {repositories.length ? (
              <ul className="mt-2 space-y-2 text-sm">
                {repositories.map((name) => (
                  <li key={name} className="break-all">
                    {name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm">
                No repositories are available yet. Choose repositories on
                GitHub, then check again.
              </p>
            )}
          </div>
        ) : null}
        {busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            Working on your connection…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DocumentationLink guide="guides/github">
          GitHub connection guide →
        </DocumentationLink>
      </div>
    </article>
  );
}
