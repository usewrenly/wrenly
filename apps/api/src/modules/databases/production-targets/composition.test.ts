/** Composition only: the supplied factories start no worker, query or remote connection. */
import { expect, test } from "bun:test";
import { db } from "@wrenly/db";
import { createProductionApp } from "../../../production-app";
import { parseApiEnvironment } from "../../../config/api-environment";
import { createProductionDatabaseHandlers } from "../http/production-handlers";
import { createInstanceProductionHttpHandlers } from "./instance/http";
import { createRuntimeHostHttpHandlers } from "./deployment-hosts/http";
import { createProjectProductionCreationHandlers } from "./project-provisioning/http";
const webUrl = "http://localhost:3000";
const environment = parseApiEnvironment({
  WRENLY_DATABASE_URL: "postgresql://fixture:fixture-only@127.0.0.1:1/fixture",
  WRENLY_AUTH_SECRET: "fixture-only-ci-auth-secret-01234567890123456789",
  WRENLY_APP_URL: "http://localhost:3002",
  WRENLY_WEB_URL: webUrl,
});
const forbidden = async (): Promise<never> => {
  throw new Error("An unauthenticated request reached persistence");
};
const setup = {
  principal: async () => null,
  admit: forbidden,
  read: forbidden,
  acknowledge: forbidden,
};
const productionDatabases = {
  instanceSetup: createInstanceProductionHttpHandlers(setup, webUrl),
  hostSetup: createRuntimeHostHttpHandlers(setup, webUrl),
  projectCreation: createProjectProductionCreationHandlers(
    { principal: async () => null, admit: forbidden, read: forbidden },
    webUrl,
  ),
  projectDatabases: createProductionDatabaseHandlers(db, {
    directory: "/tmp/unused-production-composition",
    webUrl,
    userId: async () => null,
  }),
};
test("production composition never mounts supplied setup handlers when database activation is off", async () => {
  const app = createProductionApp(environment, { productionDatabases });
  for (const path of [
    "/api/instance/production-database",
    "/api/instance/deployment-host",
    "/api/projects/00000000-0000-4000-8000-000000000001/databases/production/creation",
  ])
    expect((await app.request(path)).status).toBe(404);
});
test("verified module composition retains owner/session guards and never starts work on reads", async () => {
  const app = createProductionApp(
    { ...environment, WRENLY_APP_DATABASES_ENABLED: "true" },
    { productionDatabases },
  );
  for (const path of [
    "/api/instance/production-database",
    "/api/instance/deployment-host",
    "/api/projects/00000000-0000-4000-8000-000000000001/databases/production/creation",
  ])
    expect((await app.request(path)).status).toBe(401);
});

test("setup continuation remains a separate authenticated mutation after composition", async () => {
  const path="/api/projects/00000000-0000-4000-8000-000000000001/databases/production/creation/recovery";
  for(const enabled of [false,true]) {
    const app=createProductionApp({...environment,WRENLY_APP_DATABASES_ENABLED:enabled?"true":"false"},{productionDatabases});
    const response=await app.request(path,{method:"POST",headers:{Origin:webUrl,"Content-Type":"application/json"},body:"{}"});
    expect(response.status).toBe(enabled?401:404);
  }
});
