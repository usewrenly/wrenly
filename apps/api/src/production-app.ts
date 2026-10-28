import { createPasswordRecoveryHandler } from "./modules/auth/password-recovery/password-recovery-http";
import { completePasswordRecovery } from "./modules/auth/password-recovery/password-recovery-store";
/**
 * Production composition for the Hono API.
 * Connects authenticated HTTP handlers to instance-local persistence and server services.
 * Route registration remains separate for isolated tests; listener and worker lifecycle
 * belongs to index.ts. This module supplies dependencies, not request-owned execution.
 */
import { createProductionDatabaseHandlers } from "./modules/databases/http/production-handlers"
import { createSkillHandlers, createProjectSkillHandlers } from "./modules/skills/skill-http"
import { listSkills, readSkill, createSkill, changeSkill, getSkillAction } from "./modules/skills/skill-store"
import { readProjectSkills, changeProjectSkills } from "./modules/skills/project-skills"
import { listDeploymentHistory } from "./modules/deployments/http/deployment-history"
import { createProjectArchiveHandlers } from "./modules/projects/archive/archive-http"
import { createDraftHandlers } from "./modules/projects/drafts/draft-http"
import { createPreviewMediaHandlers } from './modules/previews/media/preview-media-http'
import {createSharingHandlers} from './modules/projects/sharing/sharing-http'
import { createMemberAccessHandlers } from "./modules/auth/members/member-access-http"
import { changeMemberAccess, getMemberAccessAction } from "./modules/auth/members/member-access-store"
import { createProfilePictureHandlers } from "./modules/auth/profile/pictures/profile-picture-http"
import { decodeProfilePicture } from "./modules/auth/profile/pictures/profile-picture-decoder"
import { getProfilePicture, readProfilePicture, saveProfilePicture } from "./modules/auth/profile/pictures/profile-picture-store"
import { createProjectSettingsHandlers } from "./modules/projects/settings/settings-http"
import { readProjectSettings, saveProjectSettings } from "./modules/projects/settings/project-settings"
import { createSetupSummaryHandler, getSetupSummary } from './modules/auth/setup/setup-summary'
import { listEnvironmentProviders, resolveEnvironmentProvider } from './modules/models/environment/environment-providers'
import { resolveInferenceSelection } from './modules/models/selection/saved-providers'
import { createProviderConfigurationHandlers } from './modules/models/configuration/provider-configuration-http'
import { createProviderConfigurationService } from './modules/models/configuration/provider-configuration-service'
import { assertProviderConfigurationOwner, listProviderConnections, getInstanceModelDefault, createProviderConnection, updateProviderConnection, saveInstanceModelDefault, resolveSavedProviderConnection } from './modules/models/configuration/provider-connection-store'
import { resolveProviderDestination } from './modules/models/transport/provider-destination'
import { readProviderModelList } from './modules/models/transport/provider-probe'
import { createCatalogHandlers } from './modules/models/catalog/provider-catalog-http'
import { getAvailableCatalog, refreshProviderCatalog } from './modules/models/catalog/provider-catalog-store'
import { createInvitationHandlers } from './modules/auth/invitations/invitation-http'
import { initializeInstanceMembership, listInstanceAccess, issueInstanceInvitation, revokeInstanceInvitation, inspectInstanceInvitation, acceptInstanceInvitation } from './modules/auth/invitations/invitation-store'
import { createLegacyRecoveryHandlers } from './modules/auth/recovery/legacy-project-recovery-http'
import { listLegacyProjects, reviewLegacyProjects, confirmLegacyProjects } from './modules/auth/recovery/legacy-project-recovery-store'
import { withRecoveryDatabase } from '@wrenly/db'
import { createOwnerRecoveryHandler } from './modules/auth/recovery/owner-recovery-http'
import { recoverInstanceOwner } from './modules/auth/recovery/owner-recovery-store'
import { createInstanceSetupHandlers } from './modules/auth/setup/instance-setup-http'
import { getInstanceSetupStatus, claimInstanceOwner } from './modules/auth/setup/instance-setup-store'
import { createInstanceAccessHandler } from './modules/auth/access/instance-access'
import { createConversationHttpHandlers } from './modules/conversations/http/http'
import { admitConversationTurn, getConversationHistory, getConversationTurnSnapshot, cancelConversationTurn } from './modules/conversations/persistence/conversation-store'
import type { Hono } from 'hono'
import type { ApiEnvironment } from './config/api-environment'
import { auth } from './modules/auth/configuration/auth'
import { listProjects, createProject } from './modules/projects/http/projects'
import { getProject } from './modules/projects/http/project'
import { createDeploymentHttpHandlers } from './modules/deployments/http/http'
import { admitDeployment, cancelQueuedDeployment, getOwnedDeployment, getLatestOwnedDeployment } from './modules/deployments/persistence/deployment-store'
import { getModels } from './modules/models/discovery/http'
import { db } from '@wrenly/db'
import { getUserId } from './modules/auth/access/session'
import { admitBuild } from './modules/builds/admission/build-admission'
import { getOwnedBuild, getOwnedBuildEvents } from './modules/builds/persistence/build-queries'
import { requestBuildCancellation } from './modules/builds/persistence/build-job-store'
import { getProvider, DEFAULT_MODEL_NAME } from './modules/models/environment/providers'
import { createBuildHttpHandlers } from './modules/builds/http/http'
import { createPreviewHttpHandlers } from './modules/previews/http/http'
import { createApp } from './app'

/** Connects the HTTP router to the existing server-only services. */
export function createProductionApp(environment: ApiEnvironment): Hono {
  const providerConfiguration = createProviderConfigurationService({
    environment: { list: listEnvironmentProviders, resolve: resolveEnvironmentProvider },
    owner: actorId => assertProviderConfigurationOwner(db, actorId), catalog: () => getAvailableCatalog(db),
    list: actorId => listProviderConnections(db, actorId), getDefault: actorId => getInstanceModelDefault(db, actorId),
    create: (actorId, input) => createProviderConnection(db, actorId, input, environment.WRENLY_DATA_DIR),
    update: (actorId, input) => updateProviderConnection(db, actorId, input, environment.WRENLY_DATA_DIR),
    saveDefault: (actorId, input) => saveInstanceModelDefault(db, actorId, input),
    resolve: id => resolveSavedProviderConnection(db, id, environment.WRENLY_DATA_DIR),
    destination: resolveProviderDestination, probe: readProviderModelList,
  })
  const invitationConfig = { secret: environment.WRENLY_AUTH_SECRET, apiUrl: environment.WRENLY_APP_URL, webUrl: environment.WRENLY_WEB_URL }
  const buildHandlers = createBuildHttpHandlers({
    userId: getUserId,
    admit: (body, userId, key) => admitBuild(body, userId, key, {
      db, allowDatabaseSelection: environment.WRENLY_APP_DATABASES_ENABLED === 'true', resolveProvider: getProvider, resolveSelection: (provider, model, transaction) => resolveInferenceSelection(transaction, provider, model), defaultModel: process.env.WRENLY_MODEL_NAME ?? DEFAULT_MODEL_NAME,
    }),
    snapshot: (id, userId) => getOwnedBuild(db, id, userId),
    events: (id, userId, after) => getOwnedBuildEvents(db, id, userId, after),
    cancel: (id, userId) => requestBuildCancellation(db, id, userId),
  })
  const publishing = createDeploymentHttpHandlers({ list: (userId, offset) => listDeploymentHistory(db, userId, offset), enabled: environment.WRENLY_PUBLISHING_ENABLED === 'true', userId: getUserId,
    admit: (projectId, userId, buildId, idempotencyKey) => admitDeployment(db, { projectId, userId, buildId, idempotencyKey, target: {
      gitInstanceUrl: new URL(environment.WRENLY_GIT_BASE_URL!).origin, repositoryOwner: environment.WRENLY_GIT_ORG,
      coolifyInstanceUrl: new URL(environment.WRENLY_COOLIFY_API_URL!).origin, coolifyProjectUuid: environment.WRENLY_COOLIFY_PROJECT_UUID!,
      coolifyServerUuid: environment.WRENLY_COOLIFY_SERVER_UUID!, coolifyEnvironmentName: environment.WRENLY_COOLIFY_ENVIRONMENT,
      registryOrigin: new URL(environment.WRENLY_REGISTRY_URL!).origin, registryNamespace: environment.WRENLY_REGISTRY_NAMESPACE,
    } }),
    cancel: (userId, projectId, id) => cancelQueuedDeployment(db, userId, projectId, id),
    get: (userId, projectId, id) => getOwnedDeployment(db, userId, projectId, id),
    latest: (userId, projectId, buildId) => getLatestOwnedDeployment(db, userId, projectId, buildId),
  })
  return createApp(
    {
      providerConfiguration: createProviderConfigurationHandlers({ webUrl: environment.WRENLY_WEB_URL, session: getUserId, service: providerConfiguration }),
      catalog: createCatalogHandlers({ webUrl: environment.WRENLY_WEB_URL, session: getUserId, catalog: () => getAvailableCatalog(db), refresh: actorId => refreshProviderCatalog(db, actorId) }),
      profilePictures: createProfilePictureHandlers({webUrl: environment.WRENLY_WEB_URL, session: getUserId, metadata: actor => getProfilePicture(db, actor), image: (actor, target, revision) => readProfilePicture(db, actor, target, revision), decode: decodeProfilePicture, save: (actor, input, bytes) => saveProfilePicture(db, actor, input, bytes)}),
      memberAccess:createMemberAccessHandlers({webUrl:environment.WRENLY_WEB_URL,session:getUserId,change:(actor,headers,input)=>changeMemberAccess(db,actor,headers,input,invitationConfig),status:(actor,id)=>getMemberAccessAction(db,actor,id)}),
      invitations: createInvitationHandlers({ webUrl: environment.WRENLY_WEB_URL, session: getUserId,
        list: actorId => listInstanceAccess(db, actorId),
        initialize: actorId => initializeInstanceMembership(db, actorId, invitationConfig),
        issue: (actorId, headers, input) => issueInstanceInvitation(db, actorId, headers, input, invitationConfig),
        revoke: (actorId, headers, input) => revokeInstanceInvitation(db, actorId, headers, input, invitationConfig),
        inspect: input => inspectInstanceInvitation(db, input),
        accept: (headers, input) => acceptInstanceInvitation(db, headers, input, invitationConfig) }),
      legacyRecovery: createLegacyRecoveryHandlers({ webUrl: environment.WRENLY_WEB_URL, session: getUserId,
        list: actorId => withRecoveryDatabase(database => listLegacyProjects(database, actorId)),
        review: (actorId, input) => withRecoveryDatabase(database => reviewLegacyProjects(database, actorId, input)),
        confirm: (actorId, input) => withRecoveryDatabase(database => confirmLegacyProjects(database, actorId, input)) }),
      passwordRecovery: createPasswordRecoveryHandler({ webUrl: environment.WRENLY_WEB_URL,
        complete: input => completePasswordRecovery(db, { secret: environment.WRENLY_AUTH_SECRET, apiUrl: environment.WRENLY_APP_URL, webUrl: environment.WRENLY_WEB_URL }, input) }),
      ownerRecovery: createOwnerRecoveryHandler({ webUrl: environment.WRENLY_WEB_URL, session: getUserId, claim: (input, userId) => recoverInstanceOwner(db, input, userId) }),
      instanceSetup: createInstanceSetupHandlers({ webUrl: environment.WRENLY_WEB_URL, status: () => getInstanceSetupStatus(db),
        claim: input => claimInstanceOwner(db, input, { secret: environment.WRENLY_AUTH_SECRET, apiUrl: environment.WRENLY_APP_URL, webUrl: environment.WRENLY_WEB_URL }) }),
      setupSummary: createSetupSummaryHandler({ userId: getUserId, summary: actorId => getSetupSummary(db, actorId, { previewEnabled: environment.WRENLY_PREVIEW_ENABLED === 'true', publishingEnabled: environment.WRENLY_PUBLISHING_ENABLED === 'true' }) }),
      instanceAccess: createInstanceAccessHandler({ singleUser: environment.WRENLY_SINGLE_USER_MODE === 'true', userId: getUserId }),
      skills: createSkillHandlers({ userId:getUserId, list: actor => listSkills(db, actor), get: (actor,id) => readSkill(db,actor,id), create: (actor,body) => createSkill(db,actor,body), save: (actor,id,body) => changeSkill(db,actor,id,body), status: (actor,id,key) => getSkillAction(db,actor,id,key) },environment.WRENLY_WEB_URL),
      projectSkills: createProjectSkillHandlers({userId:getUserId,get:(actor,id)=>readProjectSkills(db,id,actor),save:(actor,id,body)=>changeProjectSkills(db,id,actor,body)},environment.WRENLY_WEB_URL),
      listProjects,
      createProject,
      getProject: (request, id) => getProject(request, id, { database: db, session: getUserId, developmentDatabases: environment.WRENLY_APP_DATABASES_ENABLED === 'true' }),
      sharing:createSharingHandlers(db,getUserId,environment.WRENLY_WEB_URL),
      projectArchive: createProjectArchiveHandlers(db,{webUrl:environment.WRENLY_WEB_URL,userId:getUserId}),
      drafts: createDraftHandlers(db, { webUrl: environment.WRENLY_WEB_URL, userId: getUserId }),
      previewMedia: createPreviewMediaHandlers(db,{webUrl:environment.WRENLY_WEB_URL,userId:getUserId}),
      projectSettings: createProjectSettingsHandlers({webUrl:environment.WRENLY_WEB_URL,userId:getUserId,read:(userId,id)=>readProjectSettings(db,userId,id),save:(userId,id,input)=>saveProjectSettings(db,userId,id,input)}),
      deployProject: publishing.create,
      deployments: publishing,
      getModels,
      projectDatabases: environment.WRENLY_APP_DATABASES_ENABLED === 'true' ? createProductionDatabaseHandlers(db, { directory: environment.WRENLY_DATA_DIR, webUrl: environment.WRENLY_WEB_URL, userId: getUserId }) : undefined,
      builds: buildHandlers,
      conversations: createConversationHttpHandlers({
        userId: getUserId,
        admit: (projectId, userId, key, body) => admitConversationTurn(projectId, userId, key, body, {
          db, allowDatabaseSelection: environment.WRENLY_APP_DATABASES_ENABLED === 'true', resolveProvider: getProvider, resolveSelection: (provider, model, transaction) => resolveInferenceSelection(transaction, provider, model), defaultModel: process.env.WRENLY_MODEL_NAME ?? DEFAULT_MODEL_NAME,
        }),
        history: (projectId, userId, after, limit) => getConversationHistory(db, projectId, userId, after, limit),
        snapshot: (id, userId, after) => getConversationTurnSnapshot(db, id, userId, after),
        cancel: (id, userId) => cancelConversationTurn(db, id, userId),
      }),
      previews: createPreviewHttpHandlers(db, { databasesEnabled: environment.WRENLY_APP_DATABASES_ENABLED === 'true', enabled: environment.WRENLY_PREVIEW_ENABLED === 'true', baseUrl: environment.WRENLY_PREVIEW_BASE_URL,
        user: async headers => {
          const id = await getUserId(headers)
          if (!id) return null
          const current = await auth.api.getSession({ headers })
          return current ? { id, authSessionId: current.session.id } : null
        } }),
      generate: async (request) => {
        const admission = request.clone()
        if (!admission.headers.has('Idempotency-Key')) admission.headers.set('Idempotency-Key', crypto.randomUUID())
        const response = await buildHandlers.create(admission)
        if (!response.ok) return response
        const result = await response.json() as { buildId: string }
        const events = await buildHandlers.events(new Request(new URL(`/api/builds/${result.buildId}/events`, request.url), {
          headers: request.headers, signal: request.signal,
        }), result.buildId)
        events.headers.set('X-Wrenly-Build-Id', result.buildId)
        return events
      },

      auth: (request) => auth.handler(request),
    },
    { web: environment.WRENLY_WEB_URL, api: environment.WRENLY_APP_URL },
  )
}
