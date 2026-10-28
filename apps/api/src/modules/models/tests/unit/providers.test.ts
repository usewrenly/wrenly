import { expect, test } from "bun:test";
import { getProvider } from "../../environment/providers";

test("an explicit unknown provider never silently routes source to a fallback", () => {
  expect(() => getProvider("unconfigured-provider-for-test")).toThrow(
    "no longer configured",
  );
});

test("local provider remains explicit regardless of configured cloud defaults", () => {
  expect(getProvider("ollama").id).toBe("ollama");
  expect(getProvider("ollama").kind).toBe("local");
});
