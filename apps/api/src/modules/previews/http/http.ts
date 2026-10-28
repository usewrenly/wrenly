import { AccessDeniedError } from "../../auth/access/access-policy"
// Authenticated control operations for saved previews; reads never start execution.
// Access links require a live control-session binding and never expose raw credentials.
import { z } from 'zod'
import type { db } from '@wrenly/db'
import { admitSelectedBuildPreview } from "../../databases/bindings/preview-admission"
import { getOwnedPreview, stopPreview, PreviewStoreError } from '../persistence/preview-store'
import { getBuildPreview, issuePreviewGrant, previewOrigin } from '../access/preview-access'
import { logger } from '../../../lib/logger'

export interface PreviewHttpHandlers {
  get: (request: Request, id: string) => Promise<Response>
  create: (request: Request, id: string) => Promise<Response>
  stop: (request: Request, id: string) => Promise<Response>
  access: (request: Request, id: string) => Promise<Response>
}
export function createPreviewHttpHandlers(database: typeof db, configuration: {
  enabled: boolean; databasesEnabled?: boolean; baseUrl: string
  user: (headers: Headers) => Promise<{ id: string; authSessionId: string | null } | null>
}): PreviewHttpHandlers {
  const handle = (operation: 'get' | 'create' | 'stop' | 'access') => async (request: Request, id: string): Promise<Response> => {
    try {
      if (!z.string().uuid().safeParse(id).success) return Response.json({ error: 'Invalid preview/build ID.' }, { status: 400 })
      const viewer = await configuration.user(request.headers)
      if (!viewer?.authSessionId) return Response.json({ error: 'Sign in to access this preview.' }, { status: 401 })
      if (!configuration.enabled) return Response.json({ enabled: false, supported: false, preview: null, activePreview: null, error: 'Local previews are not enabled. See the local preview setup guide.' }, { status: operation === 'get' ? 200 : 503 })
      if (operation === 'get') {
        const found = await getBuildPreview(database, id, viewer.id)
        return Response.json({ enabled: true, supported: found.supported, preview: found.id ? await getOwnedPreview(database, found.id, viewer.id) : null,
          activePreview: found.activeId && found.activeId !== found.id ? await getOwnedPreview(database, found.activeId, viewer.id) : null }, { headers: { 'cache-control': 'no-store' } })
      }
      if (operation === 'create') {
        const result = await admitSelectedBuildPreview(database, id, viewer.id, request.headers.get('idempotency-key') ?? '', configuration.databasesEnabled === true)
        return Response.json(result, { status: result.replayed ? 200 : 202 })
      }
      if (operation === 'stop') {
        if (!await stopPreview(database, id, viewer.id)) return Response.json({ error: 'Preview not found.' }, { status: 404 })
        return Response.json({ stopped: true })
      }
      const token = await issuePreviewGrant(database, id, viewer.id, viewer.authSessionId)
      return Response.json({ url: previewOrigin(configuration.baseUrl, id) + '/__wrenly/bootstrap#' + token }, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      if(error instanceof AccessDeniedError)return Response.json({error:error.message},{status:401})
      if (error instanceof PreviewStoreError) return Response.json({ error: error.message }, { status: error.status })
      logger.error('Preview control request failed', { operation, errorName: error instanceof Error ? error.name : 'UnknownError' })
      return Response.json({ error: 'Preview request could not be completed. Check server diagnostics.' }, { status: 500 })
    }
  }
  return { get: handle('get'), create: handle('create'), stop: handle('stop'), access: handle('access') }
}
