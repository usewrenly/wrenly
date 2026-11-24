"use client";
/*
COMPONENT: ImageCapabilityBanner
PURPOSE: Prompt users inline inside the composer when an attached image targets a model not yet configured for image inputs, allowing an instance owner to enable support after explicit confirmation without losing their draft.
INPUTS:
  - provider: Selected provider identity (`saved:<uuid>:<uuid>` or env provider id)
  - model: Selected model ID
  - isOwner: Whether the current authenticated user is the instance owner
  - disabled: Whether composer actions are currently disabled
  - onEnabled: Async callback invoked after capability is confirmed on the server
OUTPUTS:
  - Renders nothing for unknown/invalid state; otherwise renders an inline action banner for owners of saved connections or clear guidance for env providers and non-owner members.
STEPS:
  1. Parse `saved:<uuid>:<uuid>` to extract the saved connection UUID cleanly.
  2. When owner confirms "Enable image inputs", fetch fresh connection metadata via GET /api/models/connections to read the current `imageModelIds` and `expectedImageInputRevision`.
  3. Send PATCH /api/models/connections appending `model` with `expectedImageInputRevision` CAS protection, then call `onEnabled()` so model discovery refreshes.
EDGE CASES:
  - Model was already added to `imageModelIds` concurrently -> invoke `onEnabled()` immediately.
  - Connection reaches the 100-model ceiling -> surface clear guidance linking to Settings -> Providers.
  - Environment-only provider or non-owner member -> display guidance instead of an action button.
ERROR STATES:
  - 409 revision conflict / disabled connection / network timeout -> keep button retryable and show error alert with Settings -> Providers link.
*/

import { useEffect, useState } from "react";
import { ImageIcon, Loader2Icon } from "lucide-react";
import {
  parseProviderSettings,
  providerSettingsRequest,
} from "@/lib/models/provider-settings";
import type { ComposerAttachment } from "./use-prompt-attachments";

const SAVED_PROVIDER_PREFIX = "saved:";
const SAVED_PROVIDER_PARTS = 3;
const MAX_IMAGE_MODELS_PER_CONNECTION = 100;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|webp)$/i;

/**
 * Extracts the saved provider connection UUID from a `saved:<id>:<version>` identifier.
 * Returns null for environment providers (`ollama`, `env`) or malformed identities.
 */
export function parseSavedConnectionId(provider: string): string | null {
  if (!provider.startsWith(SAVED_PROVIDER_PREFIX)) return null;
  const parts = provider.split(":");
  if (parts.length !== SAVED_PROVIDER_PARTS) return null;
  const connectionId = parts[1] ?? "";
  const version = parts[2] ?? "";
  if (!UUID_REGEX.test(connectionId) || !UUID_REGEX.test(version)) return null;
  return connectionId;
}

/**
 * Reports whether a staged composer attachment represents an image file.
 */
export function isImageAttachment(item: ComposerAttachment): boolean {
  if (item.saved?.mediaType.startsWith("image/")) return true;
  if (item.file.type.startsWith("image/")) return true;
  return IMAGE_EXTENSION_REGEX.test(item.file.name);
}

interface ImageCapabilityBannerProps {
  provider: string;
  model: string;
  isOwner: boolean;
  disabled?: boolean;
  onEnabled: () => Promise<void>;
}

/**
 * Inline prompt shown inside the composer when images are attached while using
 * a model that has not yet been reviewed for image input support.
 */
export function ImageCapabilityBanner({
  provider,
  model,
  isOwner,
  disabled = false,
  onEnabled,
}: ImageCapabilityBannerProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionId = parseSavedConnectionId(provider);

  useEffect(() => {
    setError(null);
  }, [provider, model]);

  const enableImages = async (): Promise<void> => {
    if (!connectionId || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const settings = parseProviderSettings(
        await providerSettingsRequest("/api/models/connections"),
      );
      const connection = settings.connections.find(
        (entry) => entry.id === connectionId,
      );
      if (!connection || !connection.enabled) {
        setError(
          "This saved provider connection is disabled or unavailable. Review it in Settings → Providers.",
        );
        return;
      }
      const existing = connection.imageModelIds ?? [];
      if (existing.includes(model)) {
        await onEnabled();
        return;
      }
      if (existing.length >= MAX_IMAGE_MODELS_PER_CONNECTION) {
        setError(
          "This connection already lists 100 image-capable models. Manage them in Settings → Providers.",
        );
        return;
      }
      await providerSettingsRequest("/api/models/connections", "PATCH", {
        id: connection.id,
        imageModelIds: [...existing, model],
        expectedImageInputRevision: connection.imageInputRevision,
      });
      await onEnabled();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not enable image inputs. Review this model in Settings → Providers.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      aria-label="Image input capability"
      className="mx-4 mt-2.5 flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-text-2)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <ImageIcon
            size={14}
            className="mt-0.5 shrink-0 text-[var(--color-text-2)]"
            aria-hidden="true"
          />
          <p className="min-w-0 leading-relaxed">
            {isOwner ? (
              connectionId ? (
                <>
                  <strong className="font-medium text-[var(--color-text-1)]">
                    {model}
                  </strong>{" "}
                  isn’t enabled for images yet. If this model accepts images,
                  enable image inputs to send it now.
                </>
              ) : (
                <>
                  <strong className="font-medium text-[var(--color-text-1)]">
                    {model}
                  </strong>{" "}
                  uses an environment provider. Save it in{" "}
                  <a
                    href="/settings/providers"
                    className="font-medium text-[var(--color-text-1)] underline"
                  >
                    Settings → Providers
                  </a>{" "}
                  to enable image inputs.
                </>
              )
            ) : (
              <>
                <strong className="font-medium text-[var(--color-text-1)]">
                  {model}
                </strong>{" "}
                isn’t enabled for images yet. Ask your instance owner to enable
                image inputs in Settings → Providers, or switch to an
                image-capable model.
              </>
            )}
          </p>
        </div>
        {isOwner && connectionId && (
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => void enableImages()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-2)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-1)] transition-colors hover:bg-[var(--color-bg)] disabled:opacity-50"
          >
            {busy && (
              <Loader2Icon
                size={12}
                className="animate-spin"
                aria-hidden="true"
              />
            )}
            {busy ? "Enabling…" : "Enable image inputs"}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-red-700">
          {error}{" "}
          <a href="/settings/providers" className="underline">
            Settings → Providers →
          </a>
        </p>
      )}
    </div>
  );
}
