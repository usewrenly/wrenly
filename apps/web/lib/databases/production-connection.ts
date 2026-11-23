/** One-time server setup uses credential-free status reads; secret submissions remain only in memory. */
import { z } from "zod";
import {
  ProductionConnectionInput,
  ProductionConnectionReceipt,
  ProductionConnectionState,
} from "@wrenly/db/production-connection-contract";
import { apiFetch } from "../api";
import { readProductionCreationBody } from "./production-creation";
const DEADLINE_MS = 15000;
export class ProductionConnectionError extends Error {
  constructor(readonly reason: "unavailable" | "rejected" | "unknown") {
    super(
      reason === "unavailable"
        ? "Production server setup is not enabled on this instance."
        : reason === "rejected"
          ? "This request was refused. Check current setup before reviewing again."
          : "The connection request could not be confirmed. Check its saved status before submitting another.",
    );
  }
}
type Transport = typeof apiFetch;
export type ConnectionState = z.infer<typeof ProductionConnectionState>;
export async function readProductionConnection(
  signal: AbortSignal,
  requestId?: string,
  transport: Transport = apiFetch,
): Promise<ConnectionState | null> {
  try {
    if (requestId) z.uuid().parse(requestId);
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    const response = await transport(
      `/api/instance/production-database${requestId ? `/requests/${requestId}` : ""}`,
      { cache: "no-store", signal: deadline },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProductionConnectionError(
        response.status === 404 && !requestId ? "unavailable" : "unknown",
      );
    }
    const state = ProductionConnectionState.nullable().parse(
      await readProductionCreationBody(response, deadline),
    );
    return state;
  } catch (error) {
    if (error instanceof ProductionConnectionError) throw error;
    throw new ProductionConnectionError("unknown");
  }
}
export async function submitProductionConnection(
  input: ProductionConnectionInput,
  signal: AbortSignal,
  transport: Transport = apiFetch,
): Promise<z.infer<typeof ProductionConnectionReceipt>> {
  try {
    const saved = ProductionConnectionInput.parse(input);
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    const response = await transport("/api/instance/production-database", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(saved),
      cache: "no-store",
      signal: deadline,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProductionConnectionError(
        [400, 401, 403, 409, 413, 415, 429].includes(response.status)
          ? "rejected"
          : "unknown",
      );
    }
    const receipt = ProductionConnectionReceipt.parse(
      await readProductionCreationBody(response, deadline),
    );
    return receipt;
  } catch (error) {
    if (error instanceof ProductionConnectionError) throw error;
    throw new ProductionConnectionError("unknown");
  }
}
/** Closes an interrupted read-only check; it does not retry verification or create databases. */
export async function acknowledgeProductionConnection(
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
      "/api/instance/production-database/acknowledge",
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
      throw new ProductionConnectionError("unknown");
    }
    const receipt = ProductionConnectionReceipt.parse(
      await readProductionCreationBody(response, deadline),
    );
    if (receipt.connectionId !== connectionId || receipt.status !== "failed")
      throw new Error("Unconfirmed acknowledgement");
  } catch (error) {
    if (error instanceof ProductionConnectionError) throw error;
    throw new ProductionConnectionError("unknown");
  }
}
