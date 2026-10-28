"use client";
// Keeps prompt, mode and model controls usable at narrow widths while preserving explicit submission.
//
// Composer — the primary prompt input, shared by the dashboard (creates a
// project then routes to its workspace) and the workspace (follow-up
// iterations). Add groups Plan/project tools; framework/model choices sit beside Send. Model options
// come from GET /api/models (server-side provider probes): local Ollama
// first, cloud providers grouped after — never a hardcoded list.

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Popover } from "@base-ui/react/popover";
import { ChoiceSelect } from "@/components/ui/choice-select";
import type { ConversationMode } from "@/lib/conversations/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { STACKS } from "@/lib/stacks";
import { WrenlyMark } from "@/components/wrenly-mark";
import { resolveSelection, setModelSelection, useModels } from "@/lib/models/discovery";
import type { ModelSelection } from "@/lib/models/discovery";
import { PlusIcon, Loader2Icon, ListChecksIcon } from "lucide-react";

const AVAILABLE_STACKS = new Set(["nextjs", "laravel"]);
const MAX_DRAFT_HEIGHT = 200;
const COMPACT_OPTIONS_WIDTH = 440;
const HOME_COMPACT_OPTIONS_WIDTH = 600;

interface ComposerProps {
  projectTools?: React.ReactNode;
  revisionRequest?: { id: string; text: string } | null;
  revisionBaseLabel?: string;
  fixedModel?: ModelSelection;
  readOnly?: boolean;
  onSubmit: (
    prompt: string,
    stack: string,
    model?: string,
    provider?: string,
    mode?: ConversationMode,
  ) => void | boolean | Promise<void | boolean>;
  mode?: ConversationMode;
  onModeChange?: (mode: ConversationMode) => void;
  draft?: { id: string; text: string } | null;
  framework?: string;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  variant?: "home" | "workspace";
}

export function Composer({
  onSubmit,
  projectTools,
  fixedModel,
  readOnly = false,
  disabled,
  framework,
  placeholder = "Describe the app you want to build…",
  autoFocus,
  variant = "workspace",
  mode: controlledMode,
  onModeChange,
  draft,
  revisionRequest,
  revisionBaseLabel,
}: ComposerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    setCompact(
      element.getBoundingClientRect().width <
        (variant === "home"
          ? HOME_COMPACT_OPTIONS_WIDTH
          : COMPACT_OPTIONS_WIDTH),
    );
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setCompact(
          entry.contentRect.width <
            (variant === "home"
              ? HOME_COMPACT_OPTIONS_WIDTH
              : COMPACT_OPTIONS_WIDTH),
        );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [variant]);
  const [prompt, setPrompt] = useState("");
  const consumedRevision = useRef<string | null>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const [replacement, setReplacement] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [revising, setRevising] = useState(false);
  useEffect(() => {
    if (!revisionRequest || consumedRevision.current === revisionRequest.id)
      return;
    consumedRevision.current = revisionRequest.id;
    if (readOnly || disabled || submittingRef.current) return;
    if (promptRef.current.trim() && promptRef.current !== revisionRequest.text)
      setReplacement(revisionRequest);
    else {
      setPrompt(revisionRequest.text);
      setRevising(true);
      textareaRef.current?.focus();
    }
    // A handoff is consumed once; typing must never reload the original prompt.
  }, [revisionRequest, readOnly, disabled]);
  const [localMode, setLocalMode] = useState<ConversationMode>("auto");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const mode = controlledMode ?? localMode;
  const blocked = disabled || submitting;
  useEffect(() => {
    if (!draft) return;
    setPrompt(draft.text);
    textareaRef.current?.focus();
  }, [draft]);
  const [stack, setStack] = useState<string>(STACKS[0]?.id ?? "nextjs");
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    data: models,
    isPending: modelsPending,
    isError: modelsError,
    refetch: reloadModels,
  } = useModels();

  // The persisted selection wins; otherwise resolve once discovery returns.
  useEffect(() => {
    if (!models || fixedModel) return;
    try {
      const restored = resolveSelection(models);
      setSelection((prev) => prev ?? restored);
      setPreferenceError(null);
    } catch (error) {
      setSelection(null);
      setPreferenceError(error instanceof Error ? error.message : "Model preference unavailable.");
    }
  }, [models, fixedModel]);

  const effectiveSelection = fixedModel ?? selection;
  const selectionAvailable =
    Boolean(fixedModel) ||
    Boolean(
      effectiveSelection &&
      models?.models.some(
        (option) =>
          option.id === effectiveSelection.model &&
          option.provider === effectiveSelection.provider,
      ),
    );
  const activeStack = framework ?? stack;
  const selected = STACKS.find((s) => s.id === activeStack) ?? {
    id: activeStack,
    label: activeStack,
    badge: activeStack,
  };

  // Only an actual selection may appear as a configured model.
  const modelLabel = selectionAvailable && effectiveSelection ? effectiveSelection.model : modelsPending ? "Loading models…" : "Configure models";

  const submit = async (): Promise<void> => {
    const value = prompt.trim();
    if (!value || blocked || !selectionAvailable || submittingRef.current)
      return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const accepted = await onSubmit(
        value,
        activeStack,
        effectiveSelection?.model,
        effectiveSelection?.provider,
        mode,
      );
      if (accepted === false) return;
      setPrompt("");
      setRevising(false);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch {
      // The submitting view owns its error message; keep the draft for correction.
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const choices = (
    <div className="composer-choices">
      <ChoiceSelect
        label="Framework"
        description={compact ? framework ? "Fixed for this project" : "Choose the framework for your app" : undefined}
        value={activeStack}
        disabled={blocked || Boolean(framework)}
        onChange={setStack}
        displayValue={selected.label}
        options={STACKS.map((option) => ({
          value: option.id,
          label: option.label,
          disabled: !AVAILABLE_STACKS.has(option.id),
          description: AVAILABLE_STACKS.has(option.id)
            ? undefined
            : "Coming soon",
        }))}
      />
      <ChoiceSelect
        label="Model"
        description={compact ? fixedModel ? "Selected by this project’s owner" : "The model answering your next message" : undefined}
        value={
          effectiveSelection
            ? JSON.stringify([
                effectiveSelection.provider,
                effectiveSelection.model,
              ])
            : null
        }
        disabled={blocked || modelsPending || Boolean(fixedModel)}
        displayValue={
          fixedModel
            ? `Project · ${fixedModel.model}`
            : modelsPending
              ? "Loading models…"
              : modelLabel
        }
        onChange={(value) => {
          const option = models?.models.find(
            (item) => JSON.stringify([item.provider, item.id]) === value,
          );
          if (!option) return;
          const next = { model: option.id, provider: option.provider };
          try {
            setModelSelection(next);
            setSelection(next);
            setPreferenceError(null);
          } catch (error) {
            setPreferenceError(error instanceof Error ? error.message : "Model preference unavailable.");
          }
        }}
        options={
          models?.models.map((option) => ({
            value: JSON.stringify([option.provider, option.id]),
            label: option.label,
            description: models.providers.find(
              (provider) => provider.id === option.provider,
            )?.label,
          })) ?? []
        }
        footer={<Link href="/settings/providers">Configure providers</Link>}
      />
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={`${variant === "home" ? "home-composer" : ""} rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)] transition-shadow focus-within:shadow-[var(--shadow-md)]`}
    >
      {revising && (
        <p className="composer-revision-note" role="status">
          New request from a previous prompt ·{" "}
          {revisionBaseLabel ?? "Current selected revision"}. The original
          message is unchanged.
        </p>
      )}
      <Dialog
        open={Boolean(replacement)}
        onOpenChange={(open) => {
          if (!open) setReplacement(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Replace your unsent draft?</DialogTitle>
          <DialogDescription>
            Load the previous prompt as a new request. Sending will use{" "}
            {revisionBaseLabel ?? "the current selected revision"}; your mode
            and model stay selected.
          </DialogDescription>
          <DialogFooter className="composer-revision-actions">
            <button type="button" onClick={() => setReplacement(null)}>
              Keep my draft
            </button>
            <button
              type="button"
              disabled={blocked || readOnly}
              onClick={() => {
                if (!replacement || blocked || readOnly) return;
                setPrompt(replacement.text);
                setRevising(true);
                setReplacement(null);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            >
              Replace draft
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, MAX_DRAFT_HEIGHT)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        disabled={blocked}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={variant === "home" ? 3 : 1}
        maxLength={16000}
        aria-label="Message Wrenly"
        className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-sm text-[var(--color-text-1)] outline-none placeholder:text-[var(--color-text-3)] disabled:opacity-60"
      />

      <div className="composer-controls">
        <Popover.Root>
          <Popover.Trigger className="composer-options-trigger" aria-label="Prompt options"><PlusIcon size={17} aria-hidden="true" /></Popover.Trigger>
          <Popover.Portal keepMounted>
            <Popover.Positioner side="top" align="start" sideOffset={10} className="composer-options-positioner">
              <Popover.Popup className="composer-options-popup">
                <Popover.Title>Add to your prompt</Popover.Title>
                <button type="button" className="composer-plan-toggle" role="switch" aria-label="Plan mode" aria-checked={mode === "plan"} disabled={blocked}
                  onClick={() => { const next = mode === "plan" ? "auto" : "plan"; setLocalMode(next); onModeChange?.(next); }}>
                  <ListChecksIcon size={18} aria-hidden="true" /><span><strong>Plan mode</strong><small>Work through an approach before building</small></span><span>{mode === "plan" ? "On" : "Off"}</span>
                </button>
                {compact && <section className="composer-menu-section"><h3>Build settings</h3>{choices}</section>}
                <section className="composer-menu-section"><h3>Project tools</h3>{projectTools ?? <p>Skills and media permissions are available inside a project.</p>}</section>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        {!compact && <div className="composer-right-options">{mode === "plan" && <span className="composer-plan-indicator">Plan</span>}{choices}</div>}

        {/* Send */}
        <div className="composer-send">
          <span className="hidden font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-3)] sm:inline">
            ⏎ to send
          </span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={blocked || !prompt.trim() || !selectionAvailable}
            aria-label="Send prompt"
            className="flex size-9 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-primary)] text-[var(--color-on-primary)] transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {blocked && !readOnly ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <WrenlyMark className="size-6" variant="on-primary" />
            )}
          </button>
        </div>
      </div>
      <p className="composer-guidance">{readOnly ? "You can inspect this project. An Editor or owner can send changes." : mode === "plan" ? "Plan helps you shape and revise an approach without building." : "Chats start in Auto. Use + → Plan to work through an approach without building."}</p>
      {preferenceError && <p role="alert" className="px-4 pb-3 text-xs text-[var(--color-text-2)]">{preferenceError}</p>}
      {!modelsPending && !selectionAvailable && (
        <p
          className="composer-model-notice"
          role="status"
        >
          {modelsError
            ? "Model discovery is unavailable. Your draft is preserved."
            : selection
              ? "Your selected model is unavailable. Choose an available model to continue."
              : "No model configured yet. Connect a provider to get started."}{" "}
          {!modelsError && !models?.models.length && <a href="/settings/models" className="ml-1 underline">Configure models →</a>}
          {modelsError && (
            <button
              type="button"
              onClick={() => void reloadModels()}
              className="underline"
            >
              Try again
            </button>
          )}
        </p>
      )}
    </div>
  );
}
