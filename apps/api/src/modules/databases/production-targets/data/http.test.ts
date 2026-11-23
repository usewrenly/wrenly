import { expect, test } from "bun:test";
import { accessContext } from "../../../auth/access/access-context";
import { requireProductionActionPrincipal } from "./http";
test("Production commands require the exact session captured by HTTP authentication", () => {
  expect(() => requireProductionActionPrincipal("owner")).toThrow();
  const principal = { userId: "owner", sessionId: "session", revision: crypto.randomUUID() };
  accessContext.run({ principal }, () => {
    expect(requireProductionActionPrincipal("owner")).toEqual(principal);
    expect(() => requireProductionActionPrincipal("other")).toThrow();
  });
  accessContext.run({}, () => expect(() => requireProductionActionPrincipal("owner")).toThrow());
});
