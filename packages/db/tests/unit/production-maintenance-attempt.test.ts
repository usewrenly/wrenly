import { expect, test } from "bun:test";
import {
  MaintenanceAttempt,
  beginMaintenanceEffect,
  acknowledgeMaintenanceEffect,
  expireMaintenanceAttempt,
} from "../../src/application-databases/maintenance/attempt";
function fixture(): MaintenanceAttempt {
  return {
    id: crypto.randomUUID(),
    grantRevision: crypto.randomUUID(),
    claimToken: crypto.randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    status: "running",
    pending: null,
    completed: [],
  };
}
test("restart journal requires ordered independently acknowledged effects", () => {
  let value = fixture();
  const now = new Date();
  for (const step of ["broker-start", "application-start", "route-verify"]) {
    value = beginMaintenanceEffect(
      value,
      value.claimToken,
      value.grantRevision,
      now,
    );
    expect(value.pending?.step).toBe(step);
    expect(() =>
      beginMaintenanceEffect(value, value.claimToken, value.grantRevision, now),
    ).toThrow("pending");
    expect(() =>
      acknowledgeMaintenanceEffect(
        value,
        value.claimToken,
        value.grantRevision,
        crypto.randomUUID(),
        now,
      ),
    ).toThrow("match");
    value = acknowledgeMaintenanceEffect(
      value,
      value.claimToken,
      value.grantRevision,
      value.pending!.id,
      now,
    );
  }
  expect(value.status).toBe("success");
  expect(value.pending).toBeNull();
});
test("lease expiry preserves uncertainty and rejects old or replaced authority", () => {
  let value = fixture();
  const now = new Date();
  value = beginMaintenanceEffect(
    value,
    value.claimToken,
    value.grantRevision,
    now,
  );
  expect(() =>
    acknowledgeMaintenanceEffect(
      value,
      crypto.randomUUID(),
      value.grantRevision,
      value.pending!.id,
      now,
    ),
  ).toThrow("claim");
  expect(() =>
    acknowledgeMaintenanceEffect(
      value,
      value.claimToken,
      crypto.randomUUID(),
      value.pending!.id,
      now,
    ),
  ).toThrow("claim");
  const expired = expireMaintenanceAttempt(
    value,
    new Date(Date.parse(value.leaseExpiresAt) + 1),
  );
  expect(expired.status).toBe("interrupted");
  expect(expired.pending).toEqual(value.pending);
  expect(() =>
    beginMaintenanceEffect(expired, value.claimToken, value.grantRevision, now),
  ).toThrow("claim");
});
test("malformed receipt order and premature success are refused", () => {
  const value = fixture();
  expect(
    MaintenanceAttempt.safeParse({ ...value, status: "success" }).success,
  ).toBe(false);
  expect(
    MaintenanceAttempt.safeParse({
      ...value,
      pending: { id: crypto.randomUUID(), step: "route-verify" },
    }).success,
  ).toBe(false);
});

test("owner controls have separate ordered journals and preserve reconciled pending evidence", () => {
  for (const kind of ["stop", "inspect"] as const) {
    let value = MaintenanceAttempt.parse({
      ...fixture(),
      control: {
        kind,
        actorId: "owner",
        sessionId: "session",
        accountRevision: crypto.randomUUID(),
        accessRevision: crypto.randomUUID(),
        requestIdentity: "a".repeat(64),
        originals: [],
      },
    });
    const now = new Date();
    value = beginMaintenanceEffect(
      value,
      value.claimToken,
      value.grantRevision,
      now,
    );
    expect(value.pending?.step).toBe(
      kind === "stop" ? "application-stop" : "broker-inspect",
    );
    expect(
      MaintenanceAttempt.safeParse({ ...value, status: "reconciled" }).success,
    ).toBe(false);
    const resolved = MaintenanceAttempt.parse({
      ...value,
      status: "reconciled",
      resolution: {
        controlId: crypto.randomUUID(),
        outcome: "stopped",
        verifiedAt: now.toISOString(),
      },
    });
    expect(resolved.pending).toEqual(value.pending);
    expect(() =>
      beginMaintenanceEffect(
        resolved,
        value.claimToken,
        value.grantRevision,
        now,
      ),
    ).toThrow("claim");
    expect(
      MaintenanceAttempt.safeParse({
        ...value,
        pending: { ...value.pending, step: "broker-start" },
      }).success,
    ).toBe(false);
  }
});
