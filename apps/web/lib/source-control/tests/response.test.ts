import { expect, test } from "bun:test";
import { readSourceResponse, SourceResponseError } from "../response";
test("source errors retain definite status and useful API messages", async () => {
  try {
    await readSourceResponse(
      Response.json(
        { error: "Choose a supported framework." },
        { status: 400 },
      ),
    );
    throw Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(SourceResponseError);
    expect((error as SourceResponseError).status).toBe(400);
    expect((error as Error).message).toBe("Choose a supported framework.");
  }
});
test("proxy errors and invalid acknowledgements never display response content", async () => {
  for (const status of [200, 500, 504]) {
    try {
      await readSourceResponse(
        new Response("Internal Server Error: secret fixture", { status }),
      );
      throw Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceResponseError);
      expect((error as Error).message).not.toContain("secret fixture");
      expect((error as SourceResponseError).status).toBeGreaterThanOrEqual(500);
    }
  }
  expect(await readSourceResponse(Response.json({ repositories: [] }))).toEqual(
    { repositories: [] },
  );
});
