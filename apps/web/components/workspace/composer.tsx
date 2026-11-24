"use client";
// Keeps prompt, mode and model controls usable at narrow widths while preserving explicit submission.
//
// Composer — the primary prompt input, shared by the dashboard (creates a
// project then routes to its workspace) and the workspace (follow-up
// iterations). Add groups Plan/project tools; framework/model choices sit beside Send. Model options
// come from GET /api/models (server-side provider probes): local Ollama
// first, cloud providers grouped after — never a hardcoded list.

import { usePromptAttachments } from "./attachments/use-prompt-attachments";
import { AttachmentList } from "./attachments/attachment-list";
import {
  ImageCapabilityBanner,
  isImageAttachment,
} from "./attachments/image-capability-banner";
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
import {
  resolveSelection,
  setModelSelection,
  useModels,
} from "@/lib/models/discovery";
import type { ModelSelection } from "@/lib/models/discovery";
import { useSetupSummary } from "@/lib/onboarding/setup-summary";
import { DocumentationLink } from "@/components/documentation-link";
import { useDictation } from "./dictation/use-dictation";
import { DictationPanel } from "./dictation/dictation-panel";
import { insertTranscriptText } from "./dictation/insert-transcript";
import {
  CornerDownLeftIcon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  Loader2Icon,
  ListChecksIcon,
} from "lucide-react";

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
    attachmentIds?: string[],
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
  const attachments = usePromptAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
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
  const selectionRangeRef = useRef<{
    start: number;
    end: number;
    length: number;
  } | null>(null);
  const lastDictationSnapshotRef = useRef<string | null>(null);
  const recordSelection = (element: HTMLTextAreaElement): void => {
    selectionRangeRef.current = {
      start: element.selectionStart ?? element.value.length,
      end: element.selectionEnd ?? element.value.length,
      length: element.value.length,
    };
  };
  const syncTextareaHeight = (element: HTMLTextAreaElement | null): void => {
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_DRAFT_HEIGHT)}px`;
  };
  const dictation = useDictation(
    Boolean(blocked || readOnly),
    (text) => {
      const current = promptRef.current;
      const savedRange =
        selectionRangeRef.current &&
        selectionRangeRef.current.length === current.length
          ? selectionRangeRef.current
          : null;
      const next = insertTranscriptText(current, text, savedRange);
      if (!next) return false;
      lastDictationSnapshotRef.current = current;
      selectionRangeRef.current = {
        start: next.caret,
        end: next.caret,
        length: next.text.length,
      };
      setPrompt(next.text);
      requestAnimationFrame(() => {
        const area = textareaRef.current;
        syncTextareaHeight(area);
        if (area) {
          area.focus();
          area.setSelectionRange(next.caret, next.caret);
        }
      });
      return true;
    },
    () => {
      const previous = lastDictationSnapshotRef.current;
      if (previous === null) return;
      lastDictationSnapshotRef.current = null;
      selectionRangeRef.current = null;
      setPrompt(previous);
      requestAnimationFrame(() => {
        syncTextareaHeight(textareaRef.current);
        textareaRef.current?.focus();
      });
    },
  );
  useEffect(() => {
    if (!draft) return;
    setPrompt(draft.text);
    textareaRef.current?.focus();
  }, [draft]);
  const [stack, setStack] = useState<string>(STACKS[0]?.id ?? "nextjs");
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [enabledImageNotice, setEnabledImageNotice] = useState<string | null>(
    null,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const setup = useSetupSummary();
  const isOwner = !setup.isError && setup.data?.role === "owner";

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
      setPreferenceError(
        error instanceof Error
          ? error.message
          : "Model preference unavailable.",
      );
    }
  }, [models, fixedModel]);

  const effectiveSelection = fixedModel ?? selection;
  const activeModelOption = effectiveSelection
    ? models?.models.find(
        (option) =>
          option.id === effectiveSelection.model &&
          option.provider === effectiveSelection.provider,
      )
    : undefined;
  const selectionAvailable =
    Boolean(fixedModel) || Boolean(activeModelOption);
  const hasImageAttachment = attachments.items.some(isImageAttachment);
  const activeStack = framework ?? stack;

  useEffect(() => {
    if (!hasImageAttachment) setEnabledImageNotice(null);
  }, [hasImageAttachment]);

  useEffect(() => {
    setEnabledImageNotice(null);
  }, [effectiveSelection?.model, effectiveSelection?.provider]);
  const selected = STACKS.find((s) => s.id === activeStack) ?? {
    id: activeStack,
    label: activeStack,
    badge: activeStack,
  };

  // Only an actual selection may appear as a configured model.
  const modelLabel =
    selectionAvailable && effectiveSelection
      ? effectiveSelection.model
      : modelsPending
        ? "Loading models…"
        : "Configure models";

  const submit = async (): Promise<void> => {
    const value = prompt.trim();
    if (
      !value ||
      blocked ||
      dictation.busy ||
      attachments.blocked ||
      !selectionAvailable ||
      submittingRef.current
    )
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
        attachments.ids,
      );
      if (accepted === false) return;
      setPrompt("");
      lastDictationSnapshotRef.current = null;
      selectionRangeRef.current = null;
      dictation.cancel();
      attachments.clear();
      setEnabledImageNotice(null);
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
        searchable
        searchPlaceholder="Search frameworks…"
        emptySearchText="No matching frameworks found."
        description={
          compact
            ? framework
              ? "Fixed for this project"
              : "Choose the framework for your app"
            : undefined
        }
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
        searchable
        searchPlaceholder="Search models or providers…"
        emptySearchText="No matching models found."
        description={
          compact
            ? fixedModel
              ? "Selected by this project’s owner"
              : "The model answering your next message"
            : undefined
        }
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
            setPreferenceError(
              error instanceof Error
                ? error.message
                : "Model preference unavailable.",
            );
          }
        }}
        options={
          models?.models.map((option) => {
            const providerLabel = models.providers.find(
              (provider) => provider.id === option.provider,
            )?.label;
            return {
              value: JSON.stringify([option.provider, option.id]),
              label: option.label,
              description: option.supportsImages
                ? providerLabel
                  ? `${providerLabel} · Images`
                  : "Images"
                : providerLabel,
            };
          }) ?? []
        }
        footer={<Link href="/settings/providers">Configure providers</Link>}
      />
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={variant === "home" ? "home-composer" : undefined}
    >
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)] transition-shadow focus-within:shadow-[var(--shadow-md)]">
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
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.webp,.txt,.md"
        className="sr-only"
        aria-label="Choose reference files"
        disabled={blocked || readOnly}
        onChange={(event) => {
          if (event.target.files) attachments.add(event.target.files);
          event.target.value = "";
        }}
      />
      <AttachmentList
        items={attachments.items}
        disabled={Boolean(blocked || readOnly)}
        remove={attachments.remove}
        retry={attachments.retry}
      />
      {attachments.error && (
        <p role="alert" className="px-4 pt-2 text-xs text-red-700">
          {attachments.error}
        </p>
      )}
      {hasImageAttachment &&
        selectionAvailable &&
        effectiveSelection &&
        activeModelOption?.supportsImages === false && (
          <ImageCapabilityBanner
            provider={effectiveSelection.provider}
            model={effectiveSelection.model}
            isOwner={isOwner}
            disabled={Boolean(blocked || readOnly)}
            onEnabled={async () => {
              const targetModel = effectiveSelection.model;
              await reloadModels();
              setEnabledImageNotice(
                `Image inputs enabled for ${targetModel}.`,
              );
            }}
          />
        )}
      {enabledImageNotice && hasImageAttachment && (
        <p
          role="status"
          className="mx-4 mt-2.5 flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-text-2)]"
        >
          <span>{enabledImageNotice}</span>
          <button
            type="button"
            onClick={() => setEnabledImageNotice(null)}
            className="text-[var(--color-text-3)] hover:text-[var(--color-text-1)]"
          >
            Dismiss
          </button>
        </p>
      )}
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          recordSelection(e.currentTarget);
          syncTextareaHeight(e.currentTarget);
        }}
        onSelect={(e) => recordSelection(e.currentTarget)}
        onKeyUp={(e) => recordSelection(e.currentTarget)}
        onMouseUp={(e) => recordSelection(e.currentTarget)}
        onBlur={(e) => recordSelection(e.currentTarget)}
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

      <DictationPanel dictation={dictation} disabled={Boolean(blocked || readOnly)} />
      <div className="composer-controls">
        <Popover.Root open={optionsOpen} onOpenChange={setOptionsOpen}>
          <Popover.Trigger
            className="composer-options-trigger"
            aria-label="Prompt options"
          >
            <PlusIcon size={17} aria-hidden="true" />
          </Popover.Trigger>
          <Popover.Portal keepMounted>
            <Popover.Positioner
              side="top"
              align="start"
              sideOffset={10}
              className="composer-options-positioner"
            >
              <Popover.Popup className="composer-options-popup">
                <Popover.Title>Add to your prompt</Popover.Title>
                <div className="composer-menu-list">
                  <button
                    type="button"
                    className="composer-menu-action"
                    disabled={
                      blocked || readOnly || attachments.items.length >= 4
                    }
                    onClick={() => {
                      setOptionsOpen(false);
                      fileInput.current?.click();
                    }}
                  >
                    <PaperclipIcon size={16} aria-hidden="true" />
                    <span>
                      <strong>Reference files</strong>
                      <small>
                        {attachments.items.length
                          ? `Images or text · ${attachments.items.length}/4 added`
                          : "Images or text · up to 4 files"}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="composer-plan-toggle"
                    role="switch"
                    aria-label="Plan mode"
                    aria-checked={mode === "plan"}
                    disabled={blocked}
                    onClick={() => {
                      const next = mode === "plan" ? "auto" : "plan";
                      setLocalMode(next);
                      onModeChange?.(next);
                    }}
                  >
                    <ListChecksIcon size={16} aria-hidden="true" />
                    <span>
                      <strong>Plan mode</strong>
                      <small>Work through an approach before building</small>
                    </span>
                    <span className="composer-switch-pill" aria-hidden="true">
                      <span className="composer-switch-thumb" />
                    </span>
                  </button>
                </div>
                {!dictation.available && (
                  <section className="composer-menu-section">
                    <h3>Voice dictation</h3>
                    <p>
                      {dictation.checked
                        ? "Local transcription is not enabled on this instance."
                        : "Checking local transcription…"}
                    </p>
                    <DocumentationLink guide="guides/voice-dictation">
                      Set up local dictation →
                    </DocumentationLink>
                  </section>
                )}
                {compact && (
                  <section className="composer-menu-section">
                    <h3>Build settings</h3>
                    {choices}
                  </section>
                )}
                <section className="composer-menu-section">
                  <h3>Project tools</h3>
                  {projectTools ?? (
                    <p>
                      Skills and media permissions are available inside a
                      project.
                    </p>
                  )}
                </section>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        {!compact && (
          <div className="composer-right-options">
            {mode === "plan" && (
              <span className="composer-plan-indicator">Plan</span>
            )}
            {choices}
          </div>
        )}

        {/* Send */}
        <div className="composer-send">
          {dictation.available && (
            <button
              type="button"
              aria-label="Dictate a prompt"
              disabled={Boolean(blocked || readOnly || dictation.busy)}
              onClick={dictation.begin}
              className="flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-border-2)] hover:text-[var(--color-text-1)] disabled:opacity-40"
            >
              <MicIcon size={17} aria-hidden="true" />
            </button>
          )}
          <span className="hidden items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-2)] sm:inline-flex">
            <span>to send</span>
            <CornerDownLeftIcon size={12} strokeWidth={2.2} aria-hidden="true" />
          </span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={
              blocked ||
              readOnly ||
              dictation.busy ||
              attachments.blocked ||
              !prompt.trim() ||
              !selectionAvailable
            }
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
        <p className="composer-guidance">
          {readOnly
            ? "You can inspect this project. An Editor or owner can send changes."
            : mode === "plan"
              ? "Plan helps you shape and revise an approach without building."
              : "Chats start in Auto. Use + → Plan to work through an approach without building."}
        </p>
      </div>
      {preferenceError && (
        <p
          role="alert"
          className="px-4 pt-2 text-center text-xs text-[var(--color-text-2)]"
        >
          {preferenceError}
        </p>
      )}
      {!modelsPending && !selectionAvailable && (
        <p className="composer-model-notice" role="status">
          {modelsError
            ? "Model discovery is unavailable. Your draft is preserved."
            : selection
              ? "Your selected model is unavailable. Choose an available model to continue."
              : "No model configured yet. Connect a provider to get started."}{" "}
          {!modelsError && !models?.models.length && (
            <a href="/settings/models" className="ml-1 underline">
              Configure models →
            </a>
          )}
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
