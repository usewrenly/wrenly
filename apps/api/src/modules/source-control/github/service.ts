import { createSourceImportService } from "../imports/import-service";
import {
  createGitHubReadClient,
  createGitHubAppManifest,
  readGitHubRepository,
} from "@wrenly/source-control";
/** Coordinates browser connection with fixed GitHub APIs; it never imports or pushes project code. */
import type { db } from "@wrenly/db";
import { z } from "zod";

import {
  beginSourceAuthorization,
  consumeSourceAuthorization,
  SourceConnectionError,
} from "./authorization-store";
import { sourceCallbackUrl, gitHubAuthorizationUrl } from "./authorization";
import {
  saveSourceGitHubApp,
  saveSourcePersonalConnection,
  readSourceAppForExchange,
  readSourceConnectionStatus,
  disconnectSourceConnection,
  readSourcePersonalToken,
} from "./connection-store";
import {
  exchangeGitHubManifest,
  exchangeGitHubAuthorization,
} from "./exchange";
import type { GitHubConnectionService } from "./http";
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const MAX_INSTALLATIONS = 8;
const MAX_REPOSITORIES = 200;
const Installations = z.object({
  total_count: z
    .number()
    .int()
    .min(0)
    .max(MAX_PAGES * PAGE_SIZE),
  installations: z
    .array(
      z.object({
        id: z.number().int().positive().safe(),
        app_id: z.number().int().positive().safe(),
      }),
    )
    .max(PAGE_SIZE),
});
const Repositories = z.object({
  total_count: z.number().int().min(0).max(MAX_REPOSITORIES),
  repositories: z.array(z.unknown()).max(PAGE_SIZE),
});
/** Dependency construction performs no network calls or credential loading. */
export function createGitHubConnectionService(
  database: typeof db,
  options: { webUrl: string; directory: string },
): GitHubConnectionService {
  const origin = new URL(options.webUrl).origin;
  const imports = createSourceImportService(database, options.directory);
  return {
    prepareImport: imports.prepare,
    confirmImport: imports.confirm,
    status: (principal) => readSourceConnectionStatus(database, principal),
    begin: async (principal, input) => {
      const purpose =
        input.action === "register" ? "register-app" : "connect-account";
      const pending = await beginSourceAuthorization(
        database,
        principal,
        purpose,
        origin,
        options.directory,
      );
      if (input.action === "register") {
        const manifest = createGitHubAppManifest({
          name: input.name,
          homepage: origin,
          registrationCallback: pending.callbackUrl,
          authorizationCallback: sourceCallbackUrl(origin, "connect-account"),
        });
        return {
          kind: "registration",
          url: `https://github.com/settings/apps/new?state=${encodeURIComponent(pending.state)}`,
          manifest,
        };
      }
      if (!pending.clientId)
        throw new SourceConnectionError(
          409,
          "Register the instance GitHub App first.",
        );
      return {
        kind: "authorization",
        url: gitHubAuthorizationUrl({
          clientId: pending.clientId,
          callbackUrl: pending.callbackUrl,
          state: pending.state,
          challenge: pending.challenge,
        }),
      };
    },
    complete: async (principal, purpose, state, code, signal) => {
      const claim = await consumeSourceAuthorization(
        database,
        principal,
        purpose,
        state,
        origin,
        options.directory,
      );
      if (purpose === "register-app") {
        const app = await exchangeGitHubManifest(code, fetch, signal);
        await saveSourceGitHubApp(
          database,
          principal,
          claim.id,
          app,
          options.directory,
        );
      } else {
        const app = await readSourceAppForExchange(
          database,
          principal,
          claim.id,
          options.directory,
        );
        const tokens = await exchangeGitHubAuthorization(
          { ...app, code },
          fetch,
          signal,
        );
        const identity = await createGitHubReadClient(tokens.access_token).get(
          "/user",
          signal,
        );
        await saveSourcePersonalConnection(
          database,
          principal,
          claim.id,
          tokens,
          identity,
          options.directory,
        );
      }
    },
    disconnect: (principal, version) =>
      disconnectSourceConnection(database, principal, version),
    repositories: async (principal, externalSignal) => {
      const signal = AbortSignal.any([
        externalSignal,
        AbortSignal.timeout(30000),
      ]);
      const personal = await readSourcePersonalToken(
        database,
        principal,
        options.directory,
      );
      const client = createGitHubReadClient(personal.token);
      const installations: number[] = [];
      let seen = 0,
        complete = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const list = Installations.parse(
          await client.get(
            `/user/installations?per_page=${PAGE_SIZE}&page=${page}`,
            signal,
          ),
        );
        seen += list.installations.length;
        for (const installation of list.installations)
          if (String(installation.app_id) === personal.appId)
            installations.push(installation.id);
        if (seen === list.total_count) {
          complete = true;
          break;
        }
        if (!list.installations.length || seen > list.total_count) break;
      }
      if (
        !complete ||
        installations.length > MAX_INSTALLATIONS ||
        new Set(installations).size !== installations.length
      )
        throw new SourceConnectionError(
          409,
          "The GitHub installation list could not be verified. Limit this App to the accounts you need.",
        );
      const repositories = new Map<
        string,
        ReturnType<typeof readGitHubRepository>
      >();
      for (const installation of installations) {
        let read = 0,
          finished = false;
        for (let page = 1; page <= MAX_PAGES; page++) {
          const list = Repositories.parse(
            await client.get(
              `/user/installations/${installation}/repositories?per_page=${PAGE_SIZE}&page=${page}`,
              signal,
            ),
          );
          read += list.repositories.length;
          for (const value of list.repositories) {
            if (
              value &&
              typeof value === "object" &&
              "archived" in value &&
              value.archived === true
            )
              continue;
            const repository = readGitHubRepository(value);
            repositories.set(repository.id, repository);
          }
          if (read === list.total_count) {
            finished = true;
            break;
          }
          if (!list.repositories.length || read > list.total_count) break;
        }
        if (!finished || repositories.size > MAX_REPOSITORIES)
          throw new SourceConnectionError(
            409,
            "Choose fewer repositories for this GitHub App.",
          );
      }
      // Remote reads may outlive disconnect/suspension. Recheck before exposing their result.
      const current = await readSourceConnectionStatus(database, principal);
      if (
        !current.connection ||
        current.connection.needsAuthorization ||
        current.connection.version !== personal.version
      )
        throw new SourceConnectionError(
          409,
          "Your GitHub connection changed. Reload it.",
        );
      return {
        repositories: [...repositories.values()],
        installationRequired: installations.length === 0,
      };
    },
  };
}
