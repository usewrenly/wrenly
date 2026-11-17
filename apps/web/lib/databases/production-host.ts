/** One-time deployment host setup uses credential-free status reads; secret submissions remain only in memory. */
import { z } from "zod";
import {
  ProductionRuntimeHostInput,
  ProductionRuntimeHostReceipt,
  ProductionRuntimeHostState,
} from "@wrenly/db/production-host-contract";
import { apiFetch } from "../api";
import { readProductionCreationBody } from "./production-creation";
const DEADLINE_MS = 15000;
export class ProductionHostError extends Error {
  constructor(readonly reason: "unavailable" | "rejected" | "unknown") {
    super(
      reason === "unavailable"
        ? "Deployment host setup is not enabled on this instance."
        : reason === "rejected"
          ? "This request was refused. Check current setup before reviewing again."
          : "The deployment host request could not be confirmed. Check its saved status before submitting another.",
    );
  }
}
type Transport = typeof apiFetch;
export type HostState = z.infer<typeof ProductionRuntimeHostState>;
export async function readProductionHost(
  signal: AbortSignal,
  requestId?: string,
  transport: Transport = apiFetch,
): Promise<HostState | null> {
  try {
    if (requestId) z.uuid().parse(requestId);
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    const response = await transport(
      `/api/instance/deployment-host${requestId ? `/requests/${requestId}` : ""}`,
      { cache: "no-store", signal: deadline },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProductionHostError(
        response.status === 404 && !requestId ? "unavailable" : "unknown",
      );
    }
    const state = ProductionRuntimeHostState.nullable().parse(
      await readProductionCreationBody(response, deadline),
    );
    return state;
  } catch (error) {
    if (error instanceof ProductionHostError) throw error;
    throw new ProductionHostError("unknown");
  }
}
export async function submitProductionHost(
  input: ProductionRuntimeHostInput,
  signal: AbortSignal,
  transport: Transport = apiFetch,
): Promise<z.infer<typeof ProductionRuntimeHostReceipt>> {
  try {
    const saved = ProductionRuntimeHostInput.parse(input);
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    const response = await transport("/api/instance/deployment-host", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(saved),
      cache: "no-store",
      signal: deadline,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProductionHostError(
        [400, 401, 403, 409, 413, 415, 429].includes(response.status)
          ? "rejected"
          : "unknown",
      );
    }
    const receipt = ProductionRuntimeHostReceipt.parse(
      await readProductionCreationBody(response, deadline),
    );
    return receipt;
  } catch (error) {
    if (error instanceof ProductionHostError) throw error;
    throw new ProductionHostError("unknown");
  }
}
/** Closes an interrupted read-only check; it does not retry verification or create databases. */
export async function acknowledgeProductionHost(
  connectionId: string,
  signal: AbortSignal,
  transport: Transport = apiFetch,
): Promise<void> {
  try {
    z.uuid().parse(connectionId);
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    const response = await transport(
      "/api/instance/deployment-host/acknowledge",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId, confirmInterruptedCheck: true }),
        cache: "no-store",
        signal: deadline,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProductionHostError("unknown");
    }
    const receipt = ProductionRuntimeHostReceipt.parse(
      await readProductionCreationBody(response, deadline),
    );
    if (receipt.connectionId !== connectionId || receipt.status !== "failed")
      throw new Error("Unconfirmed acknowledgement");
  } catch (error) {
    if (error instanceof ProductionHostError) throw error;
    throw new ProductionHostError("unknown");
  }
}
