/**
 * Bun API startup and shutdown boundary.
 * Validates configuration and persistence before opening listeners and starting workers.
 * Control HTTP and preview traffic use separate listeners; shutdown awaits worker cleanup
 * so a browser disconnect or process exit cannot silently replay durable work.
 */
import { existsSync } from 'fs'
import { join } from 'path'
import type { DeploymentWorkerLifecycle } from './modules/deployments/execution/production-deployment-worker'
import type { PreviewLifecycle } from './modules/previews/execution/production-preview-worker'
import { parseApiEnvironment } from './config/api-environment'
import { logger } from './lib/logger'

const API_IDLE_TIMEOUT_SECONDS = 60
try {
  const environment = parseApiEnvironment(process.env)
  const { createProductionApp } = await import('./production-app')
  const { db } = await import('@wrenly/db')
  const { startProductionBuildWorker, verifyBuildWorkerSchema } = await import('./modules/builds/execution/production-build-worker')
  const { verifyConversationSchema, startProductionConversationWorker } = await import('./modules/conversations/execution/production-conversation-worker')
  const { verifySkillsSchema } = await import("./modules/skills/skill-store")
  await verifySkillsSchema(db)
  await verifyBuildWorkerSchema(db)
  await verifyConversationSchema(db)
  if (environment.WRENLY_PUBLISHING_ENABLED === 'true') {
    const { verifyDeploymentWorkerSchema } = await import('./modules/deployments/execution/production-deployment-worker')
    await verifyDeploymentWorkerSchema(db)
  }
  const { getInstanceSetupStatus } = await import('./modules/auth/setup/instance-setup-store')
  const { verifyOwnerRecoverySchema } = await import('./modules/auth/recovery/owner-recovery-store')
  await verifyOwnerRecoverySchema(db)
  const { verifyLegacyRecoverySchema } = await import('./modules/auth/recovery/legacy-project-recovery-store')
  await verifyLegacyRecoverySchema(db)
  const { verifyInvitationSchema } = await import('./modules/auth/invitations/invitation-store')
  await verifyInvitationSchema(db)
  const { verifyProviderCatalogSchema } = await import('./modules/models/catalog/provider-catalog-store')
  await verifyProviderCatalogSchema(db)
  const { verifyProviderConnectionSchema } = await import('./modules/models/configuration/provider-connection-store')
  await verifyProviderConnectionSchema(db)
  const { verifyProfilePictureSchema } = await import("./modules/auth/profile/pictures/profile-picture-store")
  await verifyProfilePictureSchema(db)
  const {verifyMemberAccessSchema}=await import("./modules/auth/members/member-access-store")
  await verifyMemberAccessSchema(db)
  const { verifyProjectAccessSchema } = await import("./modules/projects/access/project-access")
  await verifyProjectAccessSchema(db)
  const { verifyDraftSchema } = await import("./modules/projects/drafts/draft-store")
  await verifyDraftSchema(db)
  const { verifyDatabaseSchema } = await import("./modules/databases/database-store")
  await verifyDatabaseSchema(db)
  const setupStatus = await getInstanceSetupStatus(db)
  const app = createProductionApp(environment)
  let acceptingRequests = false
  // Bind the control port before claiming any work: a second API must not interrupt queued previews on startup failure.
  const server = Bun.serve({ hostname: environment.WRENLY_API_HOST, port: environment.WRENLY_API_PORT,
    idleTimeout: API_IDLE_TIMEOUT_SECONDS, fetch(request, server) {
      // Reserve the port before claims, but expose no routes until every required host service passed startup.
      if (!acceptingRequests) return Response.json({ error: 'Wrenly is starting. Try again shortly.' }, { status: 503, headers: { 'Retry-After': '1', 'Cache-Control': 'no-store' } })
      const path = new URL(request.url).pathname
      if ((request.method === 'POST' && path === '/api/generate') || (request.method === 'GET' && /^\/api\/(builds|conversation-turns)\/[^/]+\/events$/.test(path))) server.timeout(request, 0)
      return app.fetch(request)
    } })
  let conversationWorker: Awaited<ReturnType<typeof startProductionConversationWorker>> | undefined
  let publishing: DeploymentWorkerLifecycle | undefined
  let databaseModule: PreviewLifecycle | undefined
  let previews: PreviewLifecycle | undefined
  let gateway: ReturnType<typeof Bun.serve> | undefined
  let worker: Awaited<ReturnType<typeof startProductionBuildWorker>> | undefined
  try {
    if (environment.WRENLY_PREVIEW_ENABLED === 'true') {
      const { startProductionPreviewWorker } = await import('./modules/previews/execution/production-preview-worker')
      const { createPreviewGateway } = await import('./modules/previews/gateway/preview-gateway')
      const { readAuthorizedPreviewMedia } = await import('./modules/previews/media/preview-media-store')
      const { consumePreviewGrant, authorizePreviewSession } = await import('./modules/previews/access/preview-access')
      const { touchPreviewViewer } = await import('./modules/previews/persistence/preview-store')
      const source = join(import.meta.dir, './modules/previews/gateway/preview-ingress.ts')
      let ingressBundle: Uint8Array
      const artifact = join(import.meta.dir, 'preview-ingress.js')
      if (existsSync(artifact)) ingressBundle = new Uint8Array(await Bun.file(artifact).arrayBuffer())
      else if (existsSync(source)) {
        const result = await Bun.build({ entrypoints: [source], target: 'bun' })
        if (!result.success || !result.outputs[0]) throw new Error('Trusted preview ingress build failed.')
        ingressBundle = new Uint8Array(await result.outputs[0].arrayBuffer())
      } else throw new Error('Trusted preview ingress is unavailable. Run bun run build from apps/api.')

      gateway = Bun.serve({ hostname: '127.0.0.1', port: environment.WRENLY_PREVIEW_GATEWAY_PORT, idleTimeout: 120,
        fetch: createPreviewGateway({ baseUrl: environment.WRENLY_PREVIEW_BASE_URL, controlOrigin: environment.WRENLY_WEB_URL,
          consume: (id, token) => consumePreviewGrant(db, id, token),
          authorize: (id, token) => authorizePreviewSession(db, id, token),
          touch: (id, userId) => touchPreviewViewer(db, id, userId), runtime: id => previews?.runtime(id) ?? databaseModule?.runtime(id) ?? null,
          mediaOrigins: (id, userId) => readAuthorizedPreviewMedia(db, id, userId) }) })
      previews = await startProductionPreviewWorker(db, environment, ingressBundle)
      if (environment.WRENLY_APP_DATABASES_ENABLED === 'true') {
        const { startProductionDatabaseModule } = await import('./modules/databases/production-module')
        databaseModule = await startProductionDatabaseModule(db, environment, ingressBundle)
      }
    }
    if (environment.WRENLY_PUBLISHING_ENABLED === 'true') {
      const { startProductionDeploymentWorker } = await import('./modules/deployments/execution/production-deployment-worker')
      publishing = await startProductionDeploymentWorker(db, environment)
    }
    worker = await startProductionBuildWorker(db, { databaseValidation: environment.WRENLY_APP_DATABASES_ENABLED === 'true' })
    conversationWorker = await startProductionConversationWorker(db, environment.WRENLY_MODEL_TIMEOUT_SECONDS)
  } catch (error) {
    await Promise.allSettled([server.stop(true), gateway?.stop(true), previews?.stop(), databaseModule?.stop(), worker?.stop(), conversationWorker?.stop(), publishing?.stop()])
    throw error
  }
  acceptingRequests = true
  let stopping = false
  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    acceptingRequests = false
    try {
      await Promise.all([server.stop(true), gateway?.stop(true)])
      const settled = await Promise.allSettled([worker?.stop(), previews?.stop(), databaseModule?.stop(), conversationWorker?.stop(), publishing?.stop()])
      if (settled.some(result => result.status === 'rejected')) throw new Error('Worker cleanup could not be confirmed. Inspect persisted state before restarting.')
      process.exit(0)
    } catch (error) {
      logger.error('API shutdown failed', { errorName: error instanceof Error ? error.name : 'UnknownError' })
      process.exit(1)
    }
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  if (setupStatus === 'setup-required') logger.info('Owner setup required. Run bun run setup from apps/api to open protected browser setup.')
  if (setupStatus === 'recovery-required') logger.info('Existing accounts detected; protected owner recovery is required before instance administration.')
  logger.info('Wrenly API listening', { url: server.url.toString(), runtime: 'bun', localPreviews: Boolean(previews), publishing: Boolean(publishing), developmentDatabases: Boolean(databaseModule) })
} catch (error) {
  logger.error('API startup failed', { errorName: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error && !('query' in error) ? error.message : 'Startup persistence is unavailable. Check PostgreSQL and migrations.' })
  process.exit(1)
}
