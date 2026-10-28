import { expect, test } from "bun:test";
import { createPasswordRecoveryHandler } from "../../password-recovery/password-recovery-http";
import { PasswordRecoveryError } from "../../password-recovery/password-recovery-store";
const webUrl = "http://localhost:3000";
function request(body: string, origin = webUrl): Request {
  return new Request("http://localhost:3002/api/instance/password-recovery", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
  });
}
test("password recovery rejects untrusted, malformed and oversized requests before mutation", async () => {
  let calls = 0;
  const handler = createPasswordRecoveryHandler({
    webUrl,
    complete: async () => {
      calls++;
      return { replayed: false };
    },
  });
  expect((await handler(request("{}", "https://elsewhere.test"))).status).toBe(
    403,
  );
  expect((await handler(request("{"))).status).toBe(400);
  expect((await handler(request("x".repeat(4097)))).status).toBe(400);
  expect(calls).toBe(0);
  const response = await handler(request("{}"));
  expect(await response.json()).toEqual({ completed: true, replayed: false });
  expect(response.headers.get("cache-control")).toContain("no-store");
});
test("recovery keeps explicit failures and bounds concurrent credential work", async () => {
  let finish: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handler = createPasswordRecoveryHandler({
    webUrl,
    complete: async () => {
      await wait;
      throw new PasswordRecoveryError(409, "Active work blocks recovery.");
    },
  });
  const pending = Array.from({ length: 4 }, () => handler(request("{}")));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await handler(request("{}"))).status).toBe(429);
  finish?.();
  for (const response of await Promise.all(pending))
    expect(response.status).toBe(409);
});
