/** Previously recorded resources are independently rechecked before any never-started publishing step may continue. */
import { validateProductionPublishingJournal } from "@wrenly/db/production-publishing-contract";
import { inspectProductionSetupEffect } from "./setup-inspection";
type Input = Parameters<typeof inspectProductionSetupEffect>[0];
/** A temporary read projection preserves original effect IDs; it never writes or changes old receipts. */
export async function inspectCompletedProductionEffects(
  input: Omit<Input, "effect">,
  inspect = inspectProductionSetupEffect,
): Promise<void> {
  const journal = validateProductionPublishingJournal(
    input.binding,
    input.journal,
  );
  if (journal.pending)
    throw new Error(
      "Inspect the unresolved original effect before continuing.",
    );
  for (let index = 0; index < journal.completed.length; index++) {
    const receipt = journal.completed[index]!;
    // Once attached, the independently inspected broker proves its network identity
    // and policy. The earlier empty-network proof intentionally rejects attachments.
    if (receipt.fact.step === "broker-network" && journal.completed.length > 3)
      continue;
    await input.assertHeld();
    input.signal.throwIfAborted();
    const fact = await inspect({
      ...input,
      journal: {
        ...journal,
        completed: journal.completed.slice(0, index),
        pending: receipt.effect,
      },
      effect: receipt.effect,
    });
    if (JSON.stringify(fact) !== JSON.stringify(receipt.fact))
      throw new Error(
        "Earlier publishing resource proof changed. No later effect was started.",
      );
  }
}
