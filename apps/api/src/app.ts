import type { SkillHandlers, ProjectSkillHandlers } from "./modules/skills/skill-http"
import type { ProjectArchiveHandlers } from "./modules/projects/archive/archive-http"
import type { DraftHandlers } from "./modules/projects/drafts/draft-http"
import type { PreviewMediaHandlers } from './modules/previews/media/preview-media-http'
import type { SharingHandlers } from './modules/projects/sharing/sharing-http'
import { AccessDeniedError } from "./modules/auth/access/access-policy"
import type { MemberAccessHandlers } from "./modules/auth/members/member-access-http"
import { accessContext } from "./modules/auth/access/access-context"
import type { ProfilePictureHandlers } from "./modules/auth/profile/pictures/profile-picture-http"
import type { ProjectSettingsHandlers } from "./modules/projects/settings/settings-http"
import type { DatabaseCommandHandlers } from "./modules/databases/http/command-handlers"
import type { ProviderConfigurationHandlers } from './modules/models/configuration/provider-configuration-http'
import type { CatalogHandlers } from './modules/models/catalog/provider-catalog-http'
import type { InvitationHandlers } from './modules/auth/invitations/invitation-http'
import type { LegacyRecoveryHandlers } from './modules/auth/recovery/legacy-project-recovery-http'
import type { InstanceSetupHandlers } from './modules/auth/setup/instance-setup-http'
// COMPONENT: Hono HTTP router
// PURPOSE: Bind standard Request handlers to stable API paths.
// INPUTS: Route handlers, trusted web/API origins.
// OUTPUTS: Hono app with JSON/SSE responses and native Better Auth handling.
// STEPS: Apply CORS/origin policy, register routes, handle unexpected errors safely.
// EDGE CASES: Protected instance routes are distinct from native auth; UUID paths are validated.
// ERROR STATES: Unknown routes 404; bad IDs 400; unexpected failures safe JSON 500.

import type { DeploymentHttpHandlers } from './modules/deployments/http/http'
import type { ConversationHttpHandlers } from './modules/conversations/http/http'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { logger } from './lib/logger'
import type { PreviewHttpHandlers } from './modules/previews/http/http'
import type { BuildHttpHandlers } from './modules/builds/http/http'

type RequestHandler = (request: Request) => Promise<Response>
type ProjectHandler = (request: Request, id: string) => Promise<Response>

export interface ApiHandlers {
  projectDatabases?: { status: ProjectHandler; view: ProjectHandler; actions?: DatabaseCommandHandlers; migrationReview?: ProjectHandler; recoveryReview?: ProjectHandler; recovery?: DatabaseCommandHandlers }
  skills?: SkillHandlers
  projectSkills?: ProjectSkillHandlers
  projectArchive?: ProjectArchiveHandlers
  drafts?: DraftHandlers
  previewMedia?: PreviewMediaHandlers
  memberAccess?: MemberAccessHandlers
  profilePictures?: ProfilePictureHandlers
  sharing?: SharingHandlers
  projectSettings?: ProjectSettingsHandlers
  providerConfiguration?: ProviderConfigurationHandlers
  catalog?: CatalogHandlers
  invitations?: InvitationHandlers
  legacyRecovery?: LegacyRecoveryHandlers
  passwordRecovery?: RequestHandler
  ownerRecovery?: RequestHandler
  instanceSetup?: InstanceSetupHandlers
  setupSummary?: RequestHandler
  instanceAccess?: RequestHandler
  deployments?: DeploymentHttpHandlers
  conversations?: ConversationHttpHandlers
  previews?: PreviewHttpHandlers
  builds?: BuildHttpHandlers
  listProjects: RequestHandler
  createProject: RequestHandler
  getProject: ProjectHandler
  deployProject: ProjectHandler
  getModels: RequestHandler
  generate: RequestHandler

  auth: RequestHandler
}

const ProjectIdSchema = z.string().uuid()
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Creates the HTTP adapter without initializing production services in router tests. */
export function createApp(
  handlers: ApiHandlers,
  origins: { web: string; api: string },
): Hono {
  const app = new Hono()
  app.use("/api/*", async (_context,next) => accessContext.run({},next))
  const trustedOrigins = new Set([
    new URL(origins.web).origin,
    new URL(origins.api).origin,
  ])
  app.use(
    '/api/*',
    cors({
      origin: new URL(origins.web).origin,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'Last-Event-ID'],
    }),
  )
  app.use('/api/*', async (context, next) => {
    const origin = context.req.header('Origin')
    if (
      !SAFE_METHODS.has(context.req.method) &&
      origin &&
      !trustedOrigins.has(origin)
    ) {
      return context.json({ error: 'Untrusted request origin' }, 403)
    }
    await next()
  })
  app.get('/api/health', (context) =>
    context.json({
      status: 'ok',
      service: 'wrenly-api',
      timestamp: new Date().toISOString(),
    }),
  )
  if (handlers.profilePictures) {
    const pictures = handlers.profilePictures
    app.get('/api/account/profile-picture', c => pictures.metadata(c.req.raw))
    app.put('/api/account/profile-picture', c => pictures.save(c.req.raw))
    app.delete('/api/account/profile-picture', c => pictures.remove(c.req.raw))
    app.get('/api/account/profile-picture/image', c => pictures.image(c.req.raw))
  }
  if(handlers.memberAccess){
    app.post('/api/instance/access/actions',c=>handlers.memberAccess!.change(c.req.raw))
    app.get('/api/instance/access/actions/:id',c=>handlers.memberAccess!.status(c.req.raw,c.req.param('id')))
  }
  if (handlers.invitations) {
    const invitations = handlers.invitations
    app.get('/api/instance/access/members', c => invitations.list(c.req.raw))
    app.post('/api/instance/access/initialize', c => invitations.initialize(c.req.raw))
    app.post('/api/instance/invitations', c => invitations.issue(c.req.raw))
    app.post('/api/instance/invitations/revoke', c => invitations.revoke(c.req.raw))
    app.post('/api/instance/invitations/inspect', c => invitations.inspect(c.req.raw))
    app.post('/api/instance/invitations/accept', c => invitations.accept(c.req.raw))
  }
  if (handlers.legacyRecovery) {
    const recovery = handlers.legacyRecovery
    app.get('/api/instance/legacy-projects', c => recovery.list(c.req.raw))
    app.post('/api/instance/legacy-projects/review', c => recovery.review(c.req.raw))
    app.post('/api/instance/legacy-projects/confirm', c => recovery.confirm(c.req.raw))
  }
  if (handlers.passwordRecovery) app.post('/api/instance/password-recovery', c => handlers.passwordRecovery!(c.req.raw))
  if (handlers.ownerRecovery) app.post('/api/instance/recover-owner', c => handlers.ownerRecovery!(c.req.raw))
  if (handlers.instanceSetup) {
    const setup = handlers.instanceSetup
    app.get('/api/instance/setup', c => setup.status(c.req.raw))
    app.post('/api/instance/setup', c => setup.create(c.req.raw))
  }
  if (handlers.setupSummary) app.get('/api/instance/setup-summary', c => handlers.setupSummary!(c.req.raw))
  if (handlers.instanceAccess) app.get('/api/instance/access', c => handlers.instanceAccess!(c.req.raw))
  app.on(['GET', 'POST'], '/api/auth/*', (context) =>
    handlers.auth(context.req.raw),
  )
  app.get('/api/projects', (context) => handlers.listProjects(context.req.raw))
  app.post('/api/projects', (context) =>
    handlers.createProject(context.req.raw),
  )
  app.get('/api/projects/:id', async (context) => {
    const parsed = ProjectIdSchema.safeParse(context.req.param('id'))
    if (!parsed.success)
      return context.json({ error: 'Project ID must be a valid UUID' }, 400)
    return handlers.getProject(context.req.raw, parsed.data)
  })
  if (handlers.skills) {
    app.get('/api/skills', c => handlers.skills!.list(c.req.raw))
    app.post('/api/skills', c => handlers.skills!.create(c.req.raw))
    app.get('/api/skills/:id', c => handlers.skills!.get(c.req.raw,c.req.param('id')))
    app.patch('/api/skills/:id', c => handlers.skills!.save(c.req.raw,c.req.param('id')))
    app.get('/api/skills/:id/actions/:key', c => handlers.skills!.status(c.req.raw,c.req.param('id'),c.req.param('key')))
  }
  if (handlers.projectSkills) {
    app.get('/api/projects/:id/skills', c => handlers.projectSkills!.get(c.req.raw,c.req.param('id')))
    app.patch('/api/projects/:id/skills', c => handlers.projectSkills!.save(c.req.raw,c.req.param('id')))
  }
  if (handlers.projectArchive) {
    app.get('/api/projects/:id/archive', c => handlers.projectArchive!.get(c.req.raw, c.req.param('id')))
    app.patch('/api/projects/:id/archive', c => handlers.projectArchive!.save(c.req.raw, c.req.param('id')))
  }
  if (handlers.drafts) {
    app.get('/api/drafts', c => handlers.drafts!.list(c.req.raw))
    app.post('/api/drafts', c => handlers.drafts!.create(c.req.raw))
    app.get('/api/drafts/:id', c => handlers.drafts!.get(c.req.raw, c.req.param('id')))
    app.patch('/api/drafts/:id', c => handlers.drafts!.save(c.req.raw, c.req.param('id')))
    app.get('/api/drafts/:id/members', c => handlers.drafts!.candidates(c.req.raw, c.req.param('id')))
  }
  if(handlers.previewMedia){
    app.get('/api/projects/:id/preview-media',c=>handlers.previewMedia!.get(c.req.raw,c.req.param('id')))
    app.patch('/api/projects/:id/preview-media',c=>handlers.previewMedia!.save(c.req.raw,c.req.param('id')))
  }
  // Database handlers are explicit dependencies; absence keeps the inactive module unmounted.
  if(handlers.projectDatabases){
    app.get('/api/projects/:id/databases',c=>handlers.projectDatabases!.status(c.req.raw,c.req.param('id')))
    app.get('/api/projects/:id/databases/view',c=>handlers.projectDatabases!.view(c.req.raw,c.req.param('id')))
    if(handlers.projectDatabases.migrationReview) app.get('/api/projects/:id/databases/migration-review',c=>handlers.projectDatabases!.migrationReview!(c.req.raw,c.req.param('id')))
    if(handlers.projectDatabases.recoveryReview) app.get('/api/projects/:id/databases/recovery-review',c=>handlers.projectDatabases!.recoveryReview!(c.req.raw,c.req.param('id')))
    if(handlers.projectDatabases.recovery){
      app.post('/api/projects/:id/databases/recovery',c=>handlers.projectDatabases!.recovery!.submit(c.req.raw,c.req.param('id')))
      app.get('/api/projects/:id/databases/recovery/:requestId',c=>handlers.projectDatabases!.recovery!.acknowledgement(c.req.raw,c.req.param('id'),c.req.param('requestId')))
    }
    if(handlers.projectDatabases.actions){
      app.post('/api/projects/:id/databases/actions',c=>handlers.projectDatabases!.actions!.submit(c.req.raw,c.req.param('id')))
      app.get('/api/projects/:id/databases/actions/:requestId',c=>handlers.projectDatabases!.actions!.acknowledgement(c.req.raw,c.req.param('id'),c.req.param('requestId')))
    }
  }
  if(handlers.projectSettings){
    app.get('/api/projects/:id/settings', async (context): Promise<Response> => {
      const parsed = ProjectIdSchema.safeParse(context.req.param('id'))
      if (!parsed.success) return context.json({ error: 'Project ID must be a valid UUID' }, 400)
      return handlers.projectSettings!.get(context.req.raw, parsed.data)
    })
    app.patch('/api/projects/:id/settings', async (context): Promise<Response> => {
      const parsed = ProjectIdSchema.safeParse(context.req.param('id'))
      if (!parsed.success) return context.json({ error: 'Project ID must be a valid UUID' }, 400)
      return handlers.projectSettings!.save(context.req.raw, parsed.data)
    })
  }
  if(handlers.sharing){
    app.get('/api/projects/:id/access',c=>handlers.sharing!.get(c.req.raw,c.req.param('id')))
    app.patch('/api/projects/:id/access',c=>handlers.sharing!.save(c.req.raw,c.req.param('id')))
    app.patch('/api/projects/:id/access/model',c=>handlers.sharing!.model(c.req.raw,c.req.param('id')))
    app.get('/api/projects/:id/access/actions/:key',c=>handlers.sharing!.status(c.req.raw,c.req.param('id'),c.req.param('key')))
  }
  app.post('/api/projects/:id/deploy', async (context) => {
    const parsed = ProjectIdSchema.safeParse(context.req.param('id'))
    if (!parsed.success)
      return context.json({ error: 'Project ID must be a valid UUID' }, 400)
    return handlers.deployProject(context.req.raw, parsed.data)
  })
  if (handlers.deployments) {
    const publishing = handlers.deployments
    app.get("/api/deployments", c => publishing.list(c.req.raw))
    app.post('/api/projects/:id/deployments/:deploymentId/cancel', c => publishing.cancel(c.req.raw, c.req.param('id'), c.req.param('deploymentId')))
    app.get('/api/projects/:id/deploy', c => publishing.latest(c.req.raw, c.req.param('id')))
    app.get('/api/projects/:id/deployments/:deploymentId', c => publishing.get(c.req.raw, c.req.param('id'), c.req.param('deploymentId')))
  }
  if (handlers.providerConfiguration) {
    const configuration = handlers.providerConfiguration
    app.get('/api/models/connections', c => configuration.list(c.req.raw))
    app.post('/api/models/connections', c => configuration.create(c.req.raw))
    app.patch('/api/models/connections', c => configuration.update(c.req.raw))
    app.post('/api/models/connections/probe', c => configuration.probe(c.req.raw))
    app.put('/api/models/default', c => configuration.saveDefault(c.req.raw))
  }
  if (handlers.catalog) {
    app.get('/api/models/catalog', c => handlers.catalog!.search(c.req.raw))
    app.post('/api/models/catalog/refresh', c => handlers.catalog!.refresh(c.req.raw))
  }
  app.get('/api/models', (context) => handlers.getModels(context.req.raw))
  app.post('/api/generate', (context) => handlers.generate(context.req.raw))
  if (handlers.builds) {
    const buildHandlers = handlers.builds
    app.post('/api/builds', (context) => buildHandlers.create(context.req.raw))
    app.get('/api/builds/:id', (context) => buildHandlers.get(context.req.raw, context.req.param('id')))
    app.get('/api/builds/:id/activity', (context) => buildHandlers.activity(context.req.raw, context.req.param('id')))
    app.get('/api/builds/:id/events', (context) => buildHandlers.events(context.req.raw, context.req.param('id')))
    app.post('/api/builds/:id/cancel', (context) => buildHandlers.cancel(context.req.raw, context.req.param('id')))
  }

  if (handlers.previews) {
    const previews = handlers.previews
    app.get('/api/builds/:id/preview', c => previews.get(c.req.raw, c.req.param('id')))
    app.post('/api/builds/:id/preview', c => previews.create(c.req.raw, c.req.param('id')))
    app.post('/api/previews/:id/stop', c => previews.stop(c.req.raw, c.req.param('id')))
    app.post('/api/previews/:id/access', c => previews.access(c.req.raw, c.req.param('id')))
  }

  if (handlers.conversations) {
    const conversations = handlers.conversations
    app.post('/api/projects/:id/messages', c => conversations.create(c.req.raw, c.req.param('id')))
    app.get('/api/projects/:id/messages', c => conversations.history(c.req.raw, c.req.param('id')))
    app.get('/api/conversation-turns/:id', c => conversations.get(c.req.raw, c.req.param('id')))
    app.get('/api/conversation-turns/:id/events', c => conversations.events(c.req.raw, c.req.param('id')))
    app.post('/api/conversation-turns/:id/cancel', c => conversations.cancel(c.req.raw, c.req.param('id')))
  }

  app.notFound((context) => context.json({ error: 'Not found' }, 404))
  app.onError((error, context) => {
    if(error instanceof AccessDeniedError)return context.json({error:error.message},401)
    logger.error('API request failed', {
      method: context.req.method,
      path: context.req.path,
      error,
    })
    return context.json(
      {
        error:
          'The API could not complete this request. Check the server logs.',
      },
      500,
    )
  })
  return app
}
