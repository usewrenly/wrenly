"use client";
import { MicIcon, Loader2Icon, SquareIcon, XIcon } from "lucide-react";
import type { useDictation } from "./use-dictation";
type Dictation = ReturnType<typeof useDictation>;
/** Inline review avoids stacked dialogs and never treats recognized words as an automatic prompt submission. */
export function DictationPanel({
  dictation,
  disabled,
}: {
  dictation: Dictation;
  disabled: boolean;
}): React.JSX.Element | null {
  if (dictation.stage === "idle") return null;
  const button =
    "rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs disabled:opacity-40";
  return (
    <section
      aria-label="Voice dictation"
      className="mx-3 mb-3 space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-medium">
          <MicIcon size={15} aria-hidden="true" />
          Voice dictation
        </span>
        <button
          type="button"
          onClick={dictation.cancel}
          aria-label="Cancel dictation"
          className="rounded p-1"
        >
          <XIcon size={15} />
        </button>
      </div>
      {dictation.stage === "consent" && (
        <>
          <p className="text-xs leading-relaxed text-[var(--color-text-3)]">
            Your recording is transcribed on this instance. Audio is discarded
            afterward. Review the words before sending.
          </p>
          <button
            type="button"
            className={`${button} bg-[var(--color-primary)] text-[var(--color-on-primary)]`}
            disabled={disabled}
            onClick={dictation.consent}
          >
            Start recording
          </button>
        </>
      )}
      {dictation.stage === "permission" && (
        <p role="status" className="text-xs">
          Allow microphone access in your browser. Cancel to stop waiting.
        </p>
      )}
      {dictation.stage === "recording" && (
        <div className="flex items-center justify-between gap-3">
          <p role="status" className="flex items-center gap-2 text-xs">
            <span className="size-2 rounded-full bg-red-600" />
            Recording · {dictation.elapsed}s / 60s
          </p>
          <button
            type="button"
            className={`${button} flex items-center gap-2`}
            onClick={dictation.stop}
          >
            <SquareIcon size={12} />
            Stop and transcribe
          </button>
        </div>
      )}
      {dictation.stage === "transcribing" && (
        <p role="status" className="flex items-center gap-2 text-xs">
          <Loader2Icon size={14} className="animate-spin" />
          Transcribing on your instance…
        </p>
      )}
      {dictation.stage === "review" && (
        <>
          <label className="block space-y-2 text-xs">
            <span>Review your words</span>
            <textarea
              aria-label="Dictation transcript"
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm"
              rows={3}
              maxLength={8192}
              value={dictation.text}
              onChange={(event) => dictation.setText(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`${button} bg-[var(--color-primary)] text-[var(--color-on-primary)]`}
              disabled={disabled || !dictation.text.trim()}
              onClick={dictation.insert}
            >
              Insert into prompt
            </button>
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={dictation.begin}
            >
              Record again
            </button>
            <button type="button" className={button} onClick={dictation.cancel}>
              Discard
            </button>
          </div>
        </>
      )}
      {dictation.error && (
        <p role="alert" className="text-xs text-red-700">
          {dictation.error}
        </p>
      )}
      {dictation.stage === "error" && (
        <button
          type="button"
          className={button}
          disabled={disabled}
          onClick={dictation.begin}
        >
          Try recording again
        </button>
      )}
    </section>
  );
}
