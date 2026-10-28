import { expect, test } from "bun:test";
import {
  readAuthorizedDatabaseView,
  type DatabaseViewServices,
} from "./view-service";
import { AppDatabaseError } from "../database-contract";

const input = {
  resourceId: crypto.randomUUID(),
  revision: crypto.randomUUID(),
  environment: "development",
  table: "notes",
  rows: true,
};
const authority = {
  accessRevision: crypto.randomUUID(),
  resourceId: input.resourceId,
  resourceRevision: input.revision,
};
const result = {
  tables: ["notes"],
  table: "notes",
  columns: [
    {
      name: "body",
      type: "text",
      nullable: true,
      supported: true,
      primary: false,
    },
  ],
  rows: [["<script>text only</script>"]],
  sample: true,
  nextKey: null,
  truncatedColumns: false,
};
function services(
  query: DatabaseViewServices["query"] = async () => result,
): DatabaseViewServices {
  return { authority: async () => authority, query };
}
const signal = (): AbortSignal => new AbortController().signal;

test("viewer returns exact bounded data after two authority checks", async () => {
  let checks = 0;
  const deps = services();
  deps.authority = async () => {
    checks++;
    return authority;
  };
  expect(
    await readAuthorizedDatabaseView(deps, "project", "actor", input, signal()),
  ).toEqual(result);
  expect(checks).toBe(2);
});

test("revocation and same-role restoration discard the completed query result", async () => {
  let checks = 0;
  const deps = services();
  deps.authority = async () => ({
    ...authority,
    accessRevision:
      ++checks === 1 ? authority.accessRevision : crypto.randomUUID(),
  });
  await expect(
    readAuthorizedDatabaseView(deps, "project", "actor", input, signal()),
  ).rejects.toMatchObject({ status: 409 });
  deps.authority = async () => {
    throw new AppDatabaseError(403, "Access revoked.");
  };
  let queried = false;
  deps.query = async () => {
    queried = true;
    return result;
  };
  await expect(
    readAuthorizedDatabaseView(deps, "project", "actor", input, signal()),
  ).rejects.toMatchObject({ status: 403 });
  expect(queried).toBe(false);
});

test("schema reads cannot carry rows; responses cannot contain another table or secret fields", async () => {
  for (const bad of [
    { ...result, table: "another" },
    { ...result, password: "must not leave" },
    { ...result, rows: [["a", "extra"]] },
    { ...result, rows: [["x".repeat(129 * 1024)]] },
  ])
    await expect(
      readAuthorizedDatabaseView(
        services(async () => bad),
        "project",
        "actor",
        input,
        signal(),
      ),
    ).rejects.toMatchObject({ status: 503 });
  await expect(
    readAuthorizedDatabaseView(
      services(),
      "project",
      "actor",
      { ...input, rows: false },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 503 });
});

test("cancelled queries discard late rows and failed reads never return cached data", async () => {
  const controller = new AbortController();
  await expect(
    readAuthorizedDatabaseView(
      services(async () => {
        controller.abort();
        return result;
      }),
      "project",
      "actor",
      input,
      controller.signal,
    ),
  ).rejects.toMatchObject({ status: 503 });
  await expect(
    readAuthorizedDatabaseView(
      services(async () => {
        throw new Error("private database detail");
      }),
      "project",
      "actor",
      input,
      signal(),
    ),
  ).rejects.toThrow("could not be confirmed");
});
