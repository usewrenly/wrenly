"use client";
/** Dictation owns temporary audio only; inserting a transcript and sending a prompt remain separate actions. */
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { validateTranscript } from "@wrenly/audio";
import {
  createMicrophoneCapture,
  type MicrophoneCapture,
} from "./microphone-capture";
export type DictationStage =
  | "idle"
  | "consent"
  | "permission"
  | "recording"
  | "transcribing"
  | "review"
  | "error";
const HTTP_TIMEOUT_MS = 105_000; // Includes bounded upload, native deadline and cleanup grace.
export function useDictation(
  disabled: boolean,
  onInsert: (text: string) => boolean,
): {
  available: boolean;
  checked: boolean;
  stage: DictationStage;
  busy: boolean;
  elapsed: number;
  text: string;
  error: string;
  setText(text: string): void;
  begin(): void;
  consent(): void;
  stop(): void;
  cancel(): void;
  insert(): void;
} {
  const [available, setAvailable] = useState(false);
  const [checked, setChecked] = useState(false);
  const [stage, setStage] = useState<DictationStage>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const capture = useRef<MicrophoneCapture | null>(null);
  const operation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const accepted = useRef(false);
  const mounted = useRef(true);
  const started = useRef(0);
  const disabledNow = useRef(disabled);
  disabledNow.current = disabled;
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    void apiFetch("/api/transcription", { signal: controller.signal })
      .then(async (response) => {
        const value: unknown = await response.json();
        if (mounted.current)
          setAvailable(
            response.ok &&
              !!value &&
              typeof value === "object" &&
              "available" in value &&
              value.available === true,
          );
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        if (mounted.current) setChecked(true);
      });
    return () => {
      mounted.current = false;
      ++operation.current;
      controller.abort();
      request.current?.abort();
      void capture.current?.cancel();
    };
  }, []);
  useEffect(() => {
    if (stage !== "recording") return;
    const timer = setInterval(
      () =>
        setElapsed(
          Math.min(
            60,
            Math.floor((performance.now() - started.current) / 1000),
          ),
        ),
      1000,
    );
    return () => clearInterval(timer);
  }, [stage]);
  const cancel = (): void => {
    ++operation.current;
    request.current?.abort();
    request.current = null;
    void capture.current?.cancel();
    setText("");
    setError("");
    setStage("idle");
    setElapsed(0);
  };
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);
  const stop = async (): Promise<void> => {
    const current = operation.current;
    setStage("transcribing");
    const controller = new AbortController();
    request.current = controller;
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const audio = await capture.current?.stop();
      if (
        !mounted.current ||
        operation.current !== current ||
        disabledNow.current
      )
        return;
      if (!audio) throw Error("No speech was captured. Try recording again.");
      const response = await apiFetch("/api/transcription", {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: new Uint8Array(audio),
        signal: controller.signal,
      });
      const value: unknown = await response.json();
      if (!response.ok)
        throw Error(
          value &&
            typeof value === "object" &&
            "error" in value &&
            typeof value.error === "string"
            ? value.error
            : "The recording could not be transcribed.",
        );
      const transcript = validateTranscript(
        value && typeof value === "object" && "text" in value
          ? value.text
          : undefined,
      );
      if (
        mounted.current &&
        operation.current === current &&
        !disabledNow.current
      ) {
        setText(transcript);
        setStage("review");
      }
    } catch (failure) {
      if (mounted.current && operation.current === current) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Dictation failed. Your typed draft is unchanged.",
        );
        setStage("error");
      }
    } finally {
      clearTimeout(timer);
      if (request.current === controller) request.current = null;
    }
  };
  const record = async (): Promise<void> => {
    if (!available || disabledNow.current) return;
    const current = ++operation.current;
    setText("");
    setError("");
    setElapsed(0);
    setStage("permission");
    capture.current ??= createMicrophoneCapture();
    try {
      await capture.current.start(() => {
        if (mounted.current && operation.current === current) void stop();
      });
      if (
        !mounted.current ||
        operation.current !== current ||
        disabledNow.current
      )
        return;
      started.current = performance.now();
      setStage("recording");
    } catch (failure) {
      if (mounted.current && operation.current === current) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Microphone access failed.",
        );
        setStage("error");
      }
    }
  };
  return {
    available,
    checked,
    stage,
    elapsed,
    text,
    error,
    setText,
    busy: ["permission", "recording", "transcribing"].includes(stage),
    begin: () => {
      if (!disabledNow.current && available) {
        if (accepted.current) void record();
        else setStage("consent");
      }
    },
    consent: () => {
      accepted.current = true;
      void record();
    },
    stop: () => {
      if (stage === "recording") void stop();
    },
    cancel,
    insert: () => {
      try {
        const value = validateTranscript(text);
        if (!disabledNow.current) {
          if (onInsert(value)) cancel();
          else
            setError(
              "Your prompt is full. Shorten it before inserting these words.",
            );
        }
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Review the transcript first.",
        );
      }
    },
  };
}
