/** Ordered Production runtime coordinator. A remote failure leaves its saved intent unresolved instead of replaying it. */
import {
  ProductionPublishingReceipt,
  PRODUCTION_PUBLISHING_STEPS,
  validateProductionPublishingJournal,
  type ProductionPublishingBinding,
  type ProductionPublishingJournal,
} from "@wrenly/db/production-publishing-contract";
import type { z } from "zod";
export interface ProductionRuntimeCoordinator {
  load: () => Promise<{
    binding: ProductionPublishingBinding;
    journal: ProductionPublishingJournal;
  }>;
  begin: () => Promise<NonNullable<ProductionPublishingJournal["pending"]>>;
  acknowledge: (
    receipt: z.infer<typeof ProductionPublishingReceipt>,
  ) => Promise<void>;
  /** The adapter owns exact provider/host proof and credential lookup; it receives only already-persisted intent. */
  perform: (input: {
    binding: ProductionPublishingBinding;
    journal: ProductionPublishingJournal;
    effect: NonNullable<ProductionPublishingJournal["pending"]>;
    signal: AbortSignal;
  }) => Promise<z.infer<typeof ProductionPublishingReceipt>["fact"]>;
  assertHeld: () => Promise<void>;
}
/** Invoke once under the publishing worker's kernel lock and renewing lease; subscriptions never own this loop. */
export async function executeProductionRuntimeCoordinator(
  services: ProductionRuntimeCoordinator,
  signal: AbortSignal,
): Promise<string> {
  try {
    for (let index = 0; index <= PRODUCTION_PUBLISHING_STEPS.length; index++) {
      signal.throwIfAborted();
      await services.assertHeld();
      const state = await services.load(),
        journal = validateProductionPublishingJournal(
          state.binding,
          state.journal,
        );
      if (journal.pending)
        throw new Error("Production runtime has an unresolved effect.");
      const route = journal.completed.at(-1)?.fact;
      if (route?.step === "route-verify") return route.url;
      const effect = await services.begin();
      signal.throwIfAborted();
      await services.assertHeld();
      const saved = await services.load();
      if (
        JSON.stringify(saved.binding) !== JSON.stringify(state.binding) ||
        JSON.stringify(saved.journal.pending) !== JSON.stringify(effect)
      )
        throw new Error("Production runtime intent changed.");
      validateProductionPublishingJournal(saved.binding, saved.journal);
      const fact = await services.perform({
        binding: saved.binding,
        journal: saved.journal,
        effect,
        signal,
      });
      signal.throwIfAborted();
      await services.assertHeld();
      const receipt = ProductionPublishingReceipt.parse({
        effect,
        fact,
        completedAt: new Date().toISOString(),
      });
      if (receipt.fact.step !== effect.step)
        throw new Error("Production runtime returned a foreign effect.");
      await services.acknowledge(receipt);
      const acknowledged = await services.load();
      const checked = validateProductionPublishingJournal(
        acknowledged.binding,
        acknowledged.journal,
      );
      if (
        JSON.stringify(acknowledged.binding) !==
          JSON.stringify(saved.binding) ||
        checked.pending ||
        checked.completed.length !== saved.journal.completed.length + 1 ||
        checked.completed.at(-1)?.effect.id !== effect.id
      )
        throw new Error("Production runtime acknowledgement was not saved.");
    }
    throw new Error("Production runtime exceeded its bounded step count.");
  } catch {
    throw new Error(
      "Production runtime execution could not be confirmed. Its saved effect must be inspected before continuing.",
    );
  }
}
