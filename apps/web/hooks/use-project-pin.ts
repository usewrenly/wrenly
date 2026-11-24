"use client";
// Mutates per-user project pin state with bounded timeouts and clean React Query cache updates.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

const PIN_REQUEST_TIMEOUT_MS = 10_000;

export interface ProjectPinController {
  pendingId: string | null;
  error: string | null;
  clearError: () => void;
  togglePin: (projectId: string, nextPinned: boolean) => Promise<void>;
}

/**
 * Provides optimistic-free explicit pin toggling for projects accessible to the signed-in user.
 */
export function useProjectPin(): ProjectPinController {
  const client = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const togglePin = async (
    projectId: string,
    nextPinned: boolean,
  ): Promise<void> => {
    if (pendingId) return;
    setPendingId(projectId);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/projects/${encodeURIComponent(projectId)}/pin`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pinned: nextPinned }),
          signal: AbortSignal.timeout(PIN_REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : "Could not update project pin preference.",
        );
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: ["projects"] }),
        client.invalidateQueries({ queryKey: ["projects", "archived"] }),
        client.invalidateQueries({ queryKey: ["project", projectId] }),
      ]);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not update project pin preference.",
      );
    } finally {
      setPendingId(null);
    }
  };

  return {
    pendingId,
    error,
    clearError: () => setError(null),
    togglePin,
  };
}
