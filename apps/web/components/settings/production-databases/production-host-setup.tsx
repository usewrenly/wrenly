"use client";
/** Owner setup keeps secret fields in component memory and stores only a pending request UUID. */
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ProductionRuntimeHostInput } from "@wrenly/db/production-host-contract";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  readProductionHost,
  submitProductionHost,
  acknowledgeProductionHost,
  ProductionHostError,
  type HostState,
} from "@/lib/databases/production-host";
const POLL_MS = 1500;
export function ProductionHostSetup({
  actorId,
}: {
  actorId: string;
}): React.JSX.Element {
  const [state, setState] = useState<HostState | null>(null);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const storageKey = `wrenly:production-host-request:${JSON.stringify(actorId)}`;
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh(): Promise<void> {
      try {
        const stored = sessionStorage.getItem(storageKey);
        const id = stored === null ? undefined : z.uuid().parse(stored);
        setPending(id ?? null);
        const current = await readProductionHost(active.signal, id);
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
            error instanceof ProductionHostError
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
      const value = ProductionRuntimeHostInput.parse({
        requestId: crypto.randomUUID(),
        expectedConnectionId: state?.connectionId ?? null,
        confirmTarget: fields.get("confirm") === "on",
        serverId: String(fields.get("serverId") ?? "").trim(),
        target: {
          host: String(fields.get("host") ?? "").trim(),
          port: Number(fields.get("port")),
          user: String(fields.get("user") ?? "").trim(),
          hostKey: String(fields.get("hostKey") ?? "").trim(),
        },
        privateKey: String(fields.get("privateKey") ?? ""),
      });
      sessionStorage.setItem(storageKey, value.requestId);
      setPending(value.requestId);
      await submitProductionHost(value, active.signal);
      form.reset();
      if (!active.signal.aborted) setReload((v) => v + 1);
    } catch (error) {
      if (!active.signal.aborted)
        setMessage(
          error instanceof ProductionHostError
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
      await acknowledgeProductionHost(state.connectionId, active.signal);
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
          <h2>Database-backed deployment host</h2>
          <p>
            Connect the private machine where Coolify runs your published apps.
            Its fixed Wrenly helper delivers database access without exposing
            credentials to generated source.
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
                Private deployment hostname
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
                  defaultValue={state?.target.port ?? 22}
                />
              </label>
              <label className="grid gap-2">
                Coolify server ID
                <Input
                  name="serverId"
                  required
                  maxLength={64}
                  defaultValue={state?.serverId}
                  autoComplete="off"
                />
              </label>
              <label className="grid gap-2">
                SSH user
                <Input name="user" required maxLength={63} autoComplete="off" />
              </label>
            </div>
            <label className="grid gap-2">
              Verified Ed25519 host public key
              <Input
                name="hostKey"
                required
                maxLength={100}
                defaultValue={state?.target.hostKey}
                placeholder="ssh-ed25519 AAAA…"
                autoComplete="off"
              />
            </label>
            <label className="grid gap-2">
              OpenSSH private key
              <textarea
                name="privateKey"
                required
                maxLength={16384}
                rows={5}
                className="rounded-lg border border-input bg-transparent p-3 font-mono text-sm"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="text-sm text-[var(--color-text-2)]">
              Verify the host public key directly on your deployment machine.
              The private key is encrypted on this instance; it is never shown
              again. Install the fixed Wrenly helper before checking this host.
            </p>
            <label className="flex items-start gap-3">
              <input name="confirm" type="checkbox" required />
              <span>
                I have reviewed this deployment host and authorize a connection
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
