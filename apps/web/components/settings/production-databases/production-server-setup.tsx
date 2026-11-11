"use client";
/** Owner setup keeps secret fields in component memory and stores only a pending request UUID. */
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ProductionConnectionInput } from "@wrenly/db/production-connection-contract";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  readProductionConnection,
  submitProductionConnection,
  acknowledgeProductionConnection,
  ProductionConnectionError,
  type ConnectionState,
} from "@/lib/databases/production-connection";
const POLL_MS = 1500;
export function ProductionServerSetup({
  actorId,
}: {
  actorId: string;
}): React.JSX.Element {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const storageKey = `wrenly:production-server-request:${JSON.stringify(actorId)}`;
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh(): Promise<void> {
      try {
        const stored = sessionStorage.getItem(storageKey);
        const id = stored === null ? undefined : z.uuid().parse(stored);
        setPending(id ?? null);
        const current = await readProductionConnection(active.signal, id);
        if (active.signal.aborted) return;
        setState(current);
        setReady(true);
        setMessage(null);
        if (id && current) {
          sessionStorage.removeItem(storageKey);
          setPending(null);
        }
        if (current && ["queued", "checking"].includes(current.status))
          timer = setTimeout(() => {
            void refresh();
          }, POLL_MS);
      } catch (error) {
        if (!active.signal.aborted) {
          setReady(false);
          setMessage(
            error instanceof ProductionConnectionError
              ? error.message
              : "Saved setup could not be checked safely. Check again before submitting.",
          );
        }
      }
    }
    void refresh();
    return () => {
      active.abort();
      if (timer) clearTimeout(timer);
    };
  }, [actorId, storageKey, reload]);
  async function submit(form: HTMLFormElement): Promise<void> {
    const active = controller.current;
    if (!active || active.signal.aborted || busy || !ready || pending) return;
    setBusy(true);
    try {
      const fields = new FormData(form);
      const value = ProductionConnectionInput.parse({
        requestId: crypto.randomUUID(),
        expectedConnectionId: state?.connectionId ?? null,
        confirmTarget: fields.get("confirm") === "on",
        target: {
          version: 1,
          environment: "production",
          host: String(fields.get("host") ?? "").trim(),
          port: Number(fields.get("port")),
          database: String(fields.get("database") ?? "").trim(),
          sslmode: "verify-full",
        },
        credential: {
          user: String(fields.get("user") ?? "").trim(),
          password: String(fields.get("password") ?? ""),
        },
        ...(String(fields.get("ca") ?? "").trim()
          ? { certificateAuthority: String(fields.get("ca")).trim() }
          : {}),
      });
      sessionStorage.setItem(storageKey, value.requestId);
      setPending(value.requestId);
      await submitProductionConnection(value, active.signal);
      form.reset();
      if (!active.signal.aborted) setReload((v) => v + 1);
    } catch (error) {
      if (!active.signal.aborted)
        setMessage(
          error instanceof ProductionConnectionError
            ? error.message
            : "Review the fields and confirmation. No new request will be sent until saved status is checked.",
        );
    } finally {
      if (!active.signal.aborted) setBusy(false);
    }
  }
  async function acknowledge(): Promise<void> {
    const active = controller.current;
    if (
      !active ||
      active.signal.aborted ||
      busy ||
      state?.status !== "needs_review"
    )
      return;
    setBusy(true);
    try {
      await acknowledgeProductionConnection(state.connectionId, active.signal);
      if (!active.signal.aborted) setReload((v) => v + 1);
    } catch {
      if (!active.signal.aborted)
        setMessage(
          "The acknowledgement could not be confirmed. Check saved status before trying again.",
        );
    } finally {
      if (!active.signal.aborted) setBusy(false);
    }
  }
  const checking = state && ["queued", "checking"].includes(state.status);
  return (
    <article className="connection-card">
      <div className="grid w-full gap-4">
        <div>
          <h2>Production database server</h2>
          <p>
            Connect a separate PostgreSQL 17 server once. Wrenly then creates a
            private database and restricted accounts for each project.
          </p>
        </div>
        {state ? (
          <p role="status">
            Connection: {state.status} · {state.target.host}
          </p>
        ) : null}
        {message ? <p role="alert">{message}</p> : null}
        {pending ? (
          <p role="status">
            A saved request needs confirmation. Check its status before making
            another connection request.
          </p>
        ) : null}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setReload((v) => v + 1)}
        >
          Check saved status
        </Button>
        {state?.status === "needs_review" ? (
          <div className="grid gap-3">
            <p>
              The read-only check was interrupted. Close that check before
              reviewing a fresh connection request. This does not repeat
              verification or alter project data.
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void acknowledge();
              }}
            >
              Acknowledge interrupted check
            </Button>
          </div>
        ) : null}
        {ready && !pending && !checking && state?.status !== "needs_review" ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(event.currentTarget);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2">
                Private server hostname
                <Input
                  name="host"
                  required
                  maxLength={253}
                  placeholder="apps.internal.example"
                  autoComplete="off"
                  defaultValue={state?.target.host}
                />
              </label>
              <label className="grid gap-2">
                Port
                <Input
                  name="port"
                  type="number"
                  required
                  min={1}
                  max={65535}
                  defaultValue={state?.target.port ?? 5432}
                />
              </label>
              <label className="grid gap-2">
                Maintenance database
                <Input
                  name="database"
                  required
                  maxLength={63}
                  defaultValue={state?.target.database ?? "postgres"}
                />
              </label>
              <label className="grid gap-2">
                Management role
                <Input name="user" required maxLength={63} autoComplete="off" />
              </label>
            </div>
            <label className="grid gap-2">
              Management password
              <Input
                name="password"
                type="password"
                required
                maxLength={4096}
                autoComplete="new-password"
              />
            </label>
            <label className="grid gap-2">
              Certificate authority (optional)
              <textarea
                name="ca"
                maxLength={16384}
                rows={4}
                className="rounded-lg border border-input bg-transparent p-3 font-mono text-sm"
                placeholder="PEM certificate for your private certificate authority"
              />
            </label>
            <p className="text-sm text-[var(--color-text-2)]">
              TLS verifies the server identity. Use a dedicated application
              server, separate from Wrenly’s own database. Credentials remain
              encrypted on this instance.
            </p>
            <label className="flex items-start gap-3">
              <input name="confirm" type="checkbox" required />
              <span>
                I have reviewed this dedicated server and authorize a connection
                check.
              </span>
            </label>
            <div className="flex justify-end">
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save and check connection"}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </article>
  );
}
