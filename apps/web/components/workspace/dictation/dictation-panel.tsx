"use client";
import { MicIcon, Loader2Icon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import type { useDictation } from "./use-dictation";
type Dictation = ReturnType<typeof useDictation>;
/** Compact inline status bar; speech inserts straight into the composer for review before manual Send. */
export function DictationPanel({
  dictation,
  disabled,
}: {
  dictation: Dictation;
  disabled: boolean;
}): React.JSX.Element | null {
  if (dictation.stage === "idle") return null;
  const button =
    "rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs disabled:opacity-40";
  return (
    <section
      aria-label="Voice dictation"
      className="mx-3 mb-3 space-y-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm"
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
            Your recording is transcribed on this instance and inserted directly
            into your prompt. Audio is discarded afterward. Review before sending.
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
      {dictation.stage === "inserted" && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <p role="status" className="text-[var(--color-text-2)]">
            Dictated text added to your prompt. Edit in place before sending.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {dictation.canUndo && (
              <button
                type="button"
                className={`${button} inline-flex items-center gap-1`}
                disabled={disabled}
                onClick={dictation.undo}
              >
                <RotateCcwIcon size={12} aria-hidden="true" />
                Undo
              </button>
            )}
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={dictation.begin}
            >
              Record again
            </button>
          </div>
        </div>
      )}
      {dictation.stage === "review" && (
        <>
          <label className="block space-y-2 text-xs">
            <span>Transcript kept while prompt is full</span>
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
