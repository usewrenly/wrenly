import { expect, test } from "bun:test";
import {
  productionRecoveryAcknowledged,
  submitProductionRecovery,
  savePendingProductionRecovery,
  readPendingProductionRecovery,
  clearPendingProductionRecovery,
  type PendingProductionRecovery,
} from "../../production-recovery";
const projectId = crypto.randomUUID(),
  resourceId = crypto.randomUUID(),
  reviewId = crypto.randomUUID(),
  revision = crypto.randomUUID();
const saved: PendingProductionRecovery = {
  actorId: "owner",
  projectId,
  resourceId,
  input: {
    kind: "inspect",
    resourceId,
    requestId: crypto.randomUUID(),
    expectedRevision: revision,
    confirmInspect: true,
  },
};
const state = {
  projectId,
  projectRevision: revision,
  connectionId: null,
  creation: {
    resourceId,
    requestId: crypto.randomUUID(),
    status: "needs_review" as const,
    completedPhases: [],
    errorCode: "sql_phase_unconfirmed" as const,
  },
  review: {
    resourceId,
    reviewId,
    requestId: saved.input.requestId,
    resumedRequestId: null,
    phase: "roles" as const,
    status: "checking" as const,
  },
};
test("only an exact inspection acknowledgement clears lost-response uncertainty", () => {
  expect(productionRecoveryAcknowledged(saved, state)).toBe(true);
  expect(
    productionRecoveryAcknowledged(saved, {
      ...state,
      projectId: crypto.randomUUID(),
    }),
  ).toBe(false);
  expect(
    productionRecoveryAcknowledged(saved, {
      ...state,
      review: { ...state.review, requestId: crypto.randomUUID() },
    }),
  ).toBe(false);
  const resume: PendingProductionRecovery = {
    ...saved,
    input: {
      kind: "continue",
      reviewId,
      requestId: crypto.randomUUID(),
      expectedRevision: revision,
      confirmContinue: true,
    },
  };
  expect(productionRecoveryAcknowledged(resume, state)).toBe(false);
  expect(
    productionRecoveryAcknowledged(resume, {
      ...state,
      review: { ...state.review, resumedRequestId: resume.input.requestId },
    }),
  ).toBe(true);
});
test("recovery never resubmits another resource or exposes an unvalidated receipt", async () => {
  const signal = new AbortController().signal;
  const receipt = {
    reviewId,
    resourceId,
    phase: "roles",
    status: "queued",
    replayed: true,
  };
  expect(
    await submitProductionRecovery(saved, signal, async (_path, options) => {
      expect(JSON.parse(String(options?.body))).toEqual(saved.input);
      return Response.json({ kind: "inspect", receipt });
    }),
  ).toEqual({ kind: "inspect", receipt });
  await expect(
    submitProductionRecovery(saved, signal, async () =>
      Response.json({
        kind: "inspect",
        receipt: { ...receipt, resourceId: crypto.randomUUID() },
      }),
    ),
  ).rejects.toThrow();
  await expect(
    submitProductionRecovery(saved, signal, async () => {
      throw new Error("connection lost");
    }),
  ).rejects.toMatchObject({ reason: "unknown" });
});
test("pending recovery is actor scoped and cannot be replaced by another action", () => {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  savePendingProductionRecovery(storage, saved);
  expect(readPendingProductionRecovery(storage, "other", projectId)).toBeNull();
  const other = {
    ...saved,
    input: { ...saved.input, requestId: crypto.randomUUID() },
  };
  expect(() => savePendingProductionRecovery(storage, other)).toThrow();
  expect(() => clearPendingProductionRecovery(storage, other)).toThrow();
  expect(readPendingProductionRecovery(storage, "owner", projectId)).toEqual(
    saved,
  );
  clearPendingProductionRecovery(storage, saved);
  expect(readPendingProductionRecovery(storage, "owner", projectId)).toBeNull();
});
