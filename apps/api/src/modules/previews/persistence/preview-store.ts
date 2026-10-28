// Saves preview admission, worker ownership, status and recovery atomically.
// Queue locks bound capacity; source snapshots and claim tokens prevent revision or executor substitution.
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { hasDatabaseWork } from "../../databases/database-activity";
import { lockDatabaseQueues } from "../../databases/database-store";
import { freezePreviewDatabaseBinding } from "../../databases/bindings/preview-binding";
import { AppDatabaseError } from "../../databases/database-contract";
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { ValidatedDatabaseRevision } from "@wrenly/db/app-database-binding-contract";
import { previewDatabaseBindings } from "@wrenly/db";
import { validateLaravelSource } from '../../../../../../packages/sandbox/src/source-policy/laravel-runtime'
import { unarchivedProjectPredicate, readProjectCapabilities, requireProjectCapability, ProjectAccessError } from '../../projects/access/project-access'
import { assertActiveAccount } from "../../auth/access/access-policy"
import { and, asc, count, eq, inArray, isNull, lte, notInArray, or } from 'drizzle-orm'
import { z } from 'zod'
import type { db } from '@wrenly/db'
import { builds, projects, previews, previewQueue, previewRequests, type PreviewResources } from '../../../../../../packages/db/src/schema'
import { validateFilePaths } from '../../../../../../packages/sandbox/src/source-policy/file-paths'
import { logger } from '../../../lib/logger'

const QUEUE_LOCK_ID = 1
const PREVIEW_CAPACITY = 2
const MAX_PREVIEW_REQUEST_KEYS = 64
export const PREVIEW_LEASE_MS = 30_000
const INACTIVITY_MS = 60 * 60 * 1000
const MAX_LOG_CHARS = 256_000
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_ERROR_CHARS = 2000
const UUID = z.string().uuid()
const FILES = z.array(z.object({ path: z.string(), content: z.string() })).min(1).max(1000)
const LIVE_STATES = ['preparing', 'starting', 'ready'] as const
const TERMINAL_STATES = ['failed', 'expired', 'stopped', 'interrupted'] as const
const LOG_MARKER = '[Earlier preview output truncated]\n'
type PreviewRow = typeof previews.$inferSelect
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
export interface PreviewClaim { previewId: string; buildId: string; projectId: string; token: string; stack?: string }
export type PreviewSnapshot = Pick<PreviewRow, 'id' | 'buildId' | 'projectId' | 'status' | 'log' | 'error' | 'expiresAt' | 'createdAt' | 'updatedAt'> & { cleanupPending: boolean }
export class PreviewStoreError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503, message: string) { super(message); this.name = 'PreviewStoreError' }
}
export class PreviewClaimLostError extends Error {
  constructor() { super('Preview execution no longer owns a valid lease.'); this.name = 'PreviewClaimLostError' }
}
function logFailure(error: unknown, operation: string): void {
  if (!(error instanceof PreviewStoreError) && !(error instanceof PreviewClaimLostError))
    logger.error('Preview store operation failed', { operation, errorName: error instanceof Error ? error.name : 'UnknownError' })
}
async function lockQueue(transaction: Transaction): Promise<void> {
  await transaction.insert(previewQueue).values({ id: QUEUE_LOCK_ID }).onConflictDoNothing()
  await transaction.select().from(previewQueue).where(eq(previewQueue.id, QUEUE_LOCK_ID)).for('update')
}
function claimOf(row: PreviewRow): PreviewClaim {
  if (!row.claimToken) throw new PreviewClaimLostError()
  return { previewId: row.id, projectId: row.projectId, buildId: row.buildId, token: row.claimToken }
}
async function ownedClaim(transaction: Transaction, claim: PreviewClaim, allowStoppedLogs = false): Promise<PreviewRow> {
  const [row] = await transaction.select().from(previews).where(eq(previews.id, claim.previewId)).for('update')
  const now = Date.now()
  if (!row || row.claimToken !== claim.token || row.buildId !== claim.buildId || row.projectId !== claim.projectId ||
    !(LIVE_STATES.some(status => status === row.status) || (allowStoppedLogs && row.status === 'stopped' && !row.cleanupCompletedAt)) || !row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= now ||
    (row.status === 'ready' && (!row.expiresAt || row.expiresAt.getTime() <= now))) throw new PreviewClaimLostError()
  return row
}

/** Reserves immutable source once; retries of admission never start duplicate preparation. */
export async function admitPreview(database: typeof db, buildId: string, userId: string, key: string): Promise<{ previewId: string; replayed: boolean }> {
  return admitSelectedPreview(database, buildId, userId, key);
}

/** Trusted internal admission only; ordinary preview HTTP does not call this until runtime activation gates pass. */
export async function admitDatabasePreview(database: typeof db, buildId: string, userId: string, key: string,
  value: unknown): Promise<{ previewId: string; replayed: boolean }> {
  const parsed = BuildDatabaseSelection.safeParse(value);
  if (!parsed.success) throw new PreviewStoreError(400, 'Choose the exact Development database revision.');
  return admitSelectedPreview(database, buildId, userId, key, parsed.data);
}

async function admitSelectedPreview(database: typeof db, buildId: string, userId: string, key: string,
  databaseSelection?: BuildDatabaseSelection): Promise<{ previewId: string; replayed: boolean }> {
  if (!UUID.safeParse(buildId).success || !UUID.safeParse(key).success) throw new PreviewStoreError(400, 'Provide a build ID and UUID request key.')
  try {
    return await database.transaction(async transaction => {
      if (databaseSelection) await lockDatabaseQueues(transaction); else await lockQueue(transaction)
      await assertActiveAccount(transaction, userId)
      const [build] = await transaction.select({ build: builds, owner: projects.userId, projectStack: projects.stack }).from(builds)
        .innerJoin(projects, eq(projects.id, builds.projectId)).where(eq(builds.id, buildId))
      if (!build) throw new PreviewStoreError(404, 'Build not found.')
      try { await requireProjectCapability(transaction, build.build.projectId, userId, 'contribute') } catch(error) { if(error instanceof ProjectAccessError) throw new PreviewStoreError(error.status,error.message); throw error }
      const [replay] = await transaction.select({ preview: previews }).from(previewRequests)
        .innerJoin(previews, eq(previews.id, previewRequests.previewId))
        .where(and(eq(previewRequests.userId, userId), eq(previewRequests.key, key)))
      if (replay) {
        if (replay.preview.buildId !== buildId) throw new PreviewStoreError(409, 'This request key belongs to another build.')
        if (databaseSelection) {
          const [saved] = await transaction.select().from(previewDatabaseBindings).where(eq(previewDatabaseBindings.previewId, replay.preview.id));
          const proof = ValidatedDatabaseRevision.safeParse(saved?.revision);
          if (!proof.success || proof.data.binding.resourceId !== databaseSelection.resourceId || proof.data.binding.resourceRevision !== databaseSelection.resourceRevision)
            throw new PreviewStoreError(409, 'This request key belongs to a different database revision.');
        } else if (replay.preview.files.some(file => file.path === 'wrenly.app.json')) {
          throw new PreviewStoreError(409, 'Use the explicit database preview request to inspect this reservation.');
        }
        return { previewId: replay.preview.id, replayed: true }
      }
      if (build.build.status !== 'success') throw new PreviewStoreError(409, 'Only a successful build can be previewed.')
      if (!['nextjs', 'laravel'].includes(build.build.stack ?? build.projectStack)) throw new PreviewStoreError(400, 'Local preview supports Next.js and Laravel 13 builds.')
      const files = FILES.safeParse(build.build.files)
      if (!files.success || Buffer.byteLength(JSON.stringify(files.data)) > MAX_SOURCE_BYTES)
        throw new PreviewStoreError(409, 'This build has no valid saved source for preview.')
      if ((build.build.stack ?? build.projectStack) === 'laravel') {
        try { validateLaravelSource(files.data) } catch { throw new PreviewStoreError(409, 'This revision needs valid Laravel 13 source before it can be previewed. Older revisions are not silently upgraded.') }
      }
      try {
        const manifest = readAppDatabaseManifest(files.data, build.build.stack ?? build.projectStack);
        if (manifest && !databaseSelection) throw new PreviewStoreError(409, 'This revision declares a database. Build with an explicitly selected Development resource, then review and apply its migrations before previewing.')
        if (!manifest && databaseSelection) throw new PreviewStoreError(409, 'This saved revision does not declare an application database.')
      } catch (error) { if (error instanceof PreviewStoreError) throw error; throw new PreviewStoreError(409, 'Review this revision’s database manifest and frozen migrations before previewing.') }
      try { validateFilePaths(files.data) } catch { throw new PreviewStoreError(409, 'Saved source contains unsupported file paths.') }
      if (await hasDatabaseWork(transaction, build.build.projectId)) throw new PreviewStoreError(409, 'Finish or reconcile database work before starting a preview.');
      let databaseEvidence: ValidatedDatabaseRevision | undefined;
      if (databaseSelection) {
        try { databaseEvidence = await freezePreviewDatabaseBinding(transaction, build.build.projectId, buildId, userId, databaseSelection); }
        catch (error) { if (error instanceof AppDatabaseError) throw new PreviewStoreError(error.status === 503 ? 409 : error.status, error.message); throw error; }
      }
      const [active] = await transaction.select().from(previews)
        .where(and(eq(previews.projectId, build.build.projectId), isNull(previews.cleanupCompletedAt)))
      if (active && (active.buildId !== buildId || TERMINAL_STATES.some(status => status === active.status)))
        throw new PreviewStoreError(409, 'Stop and clean the existing preview before preparing this revision.')
      if (active) {
        if (databaseEvidence) {
          const [saved] = await transaction.select().from(previewDatabaseBindings).where(eq(previewDatabaseBindings.previewId, active.id));
          const parsed = ValidatedDatabaseRevision.safeParse(saved?.revision);
          if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(databaseEvidence))
            throw new PreviewStoreError(409, 'Stop and clean the preview before changing its database evidence.');
        }
        const [keys] = await transaction.select({ total: count() }).from(previewRequests).where(eq(previewRequests.previewId, active.id))
        if ((keys?.total ?? 0) >= MAX_PREVIEW_REQUEST_KEYS) throw new PreviewStoreError(429, 'Reuse the original preview request key or stop the preview before submitting more requests.')
        await transaction.insert(previewRequests).values({ userId, key, previewId: active.id })
        return { previewId: active.id, replayed: true }
      }
      const [capacity] = await transaction.select({ total: count() }).from(previews).where(isNull(previews.cleanupCompletedAt))
      if ((capacity?.total ?? 0) >= PREVIEW_CAPACITY) throw new PreviewStoreError(429, 'Local preview capacity is full. Stop an existing preview first.')
      const id = crypto.randomUUID()
      await transaction.insert(previews).values({ id, buildId, projectId: build.build.projectId, userId, files: files.data })
      if (databaseEvidence) await transaction.insert(previewDatabaseBindings).values({ previewId: id, resourceId: databaseEvidence.binding.resourceId, revision: databaseEvidence });
      await transaction.insert(previewRequests).values({ userId, key, previewId: id })
      return { previewId: id, replayed: false }
    })
  } catch (error) { logFailure(error, 'admitPreview'); throw error }
}

/** Claims only one preparation globally; abandoned work must be reconciled first. */
export async function claimNextPreview(database: typeof db): Promise<(PreviewClaim & { files: PreviewRow['files'] }) | null> {
  try {
    return await database.transaction(async transaction => {
      await lockQueue(transaction)
      const [busy] = await transaction.select({ id: previews.id }).from(previews).where(and(
        isNull(previews.cleanupCompletedAt), notInArray(previews.status, ['queued', 'ready']),
      )).limit(1)
      if (busy) return null
      const candidates = await transaction.select().from(previews).where(and(eq(previews.status, 'queued'), unarchivedProjectPredicate(transaction, previews.projectId)))
        .orderBy(asc(previews.createdAt), asc(previews.id)).limit(PREVIEW_CAPACITY).for('update')
      // Database reservations must wait for their explicitly installed runtime adapter.
      // Never hand their source to the stateless worker or query an inactive module's table here.
      const row = candidates.find(candidate => !candidate.files.some(file => file.path === 'wrenly.app.json'))
      if (!row) return null
      const [build] = await transaction.select({ stack: builds.stack, projectStack: projects.stack }).from(builds)
        .innerJoin(projects, eq(projects.id, builds.projectId)).where(eq(builds.id, row.buildId))
      if (!build) throw new Error('Preview revision no longer exists.')
      const token = crypto.randomUUID()
      await transaction.update(previews).set({ status: 'preparing', claimToken: token,
        leaseExpiresAt: new Date(Date.now() + PREVIEW_LEASE_MS), updatedAt: new Date() }).where(eq(previews.id, row.id))
      return { previewId: row.id, buildId: row.buildId, projectId: row.projectId, token, files: row.files, stack: build.stack ?? build.projectStack }
    })
  } catch (error) { logFailure(error, 'claimNextPreview'); throw error }
}

/** Ready previews retain a management lease; only viewer activity extends inactivity expiry. */
export async function renewPreviewLease(database: typeof db, claim: PreviewClaim): Promise<void> {
  try {
    await database.transaction(async transaction => {
      await ownedClaim(transaction, claim)
      await transaction.update(previews).set({ leaseExpiresAt: new Date(Date.now() + PREVIEW_LEASE_MS) }).where(eq(previews.id, claim.previewId))
    })
  } catch (error) { logFailure(error, 'renewPreviewLease'); throw error }
}

/** Persists bounded logs and strictly ordered preparation/start/ready transitions. */
export async function updatePreviewProgress(database: typeof db, claim: PreviewClaim,
  progress: { type: 'log'; text: string } | { type: 'starting'; resources: PreviewResources } | { type: 'ready' }): Promise<void> {
  try {
    await database.transaction(async transaction => {
      const row = await ownedClaim(transaction, claim, progress.type === 'log')
      const patch: Partial<typeof previews.$inferInsert> = { updatedAt: new Date() }
      if (progress.type === 'log') {
        const log = row.log + progress.text.slice(-MAX_LOG_CHARS)
        patch.log = log.length > MAX_LOG_CHARS ? LOG_MARKER + log.slice(-(MAX_LOG_CHARS - LOG_MARKER.length)) : log
      } else if (progress.type === 'starting') {
        if (row.status !== 'preparing' || !(['appContainerId', 'ingressContainerId', 'appNetworkId', 'ingressNetworkId'] as const)
          .every(name => /^[0-9a-f]{64}$/.test(progress.resources[name])))
          throw new PreviewStoreError(409, 'Preview start requires valid owned runtime resources.')
        const preparation = progress.resources.preparation
        if (preparation && (!/^sha256:[0-9a-f]{64}$/.test(preparation.imageId) ||
          !(preparation.lockfileSha256 === null || /^[0-9a-f]{64}$/.test(preparation.lockfileSha256))))
          throw new PreviewStoreError(409, 'Preview preparation identity is invalid.')
        patch.status = 'starting'; patch.resources = progress.resources
      } else {
        if (row.status !== 'starting' || !row.resources) throw new PreviewStoreError(409, 'Preview must start before becoming ready.')
        patch.status = 'ready'; patch.expiresAt = new Date(Date.now() + INACTIVITY_MS)
      }
      await transaction.update(previews).set(patch).where(eq(previews.id, row.id))
    })
  } catch (error) { logFailure(error, 'updatePreviewProgress'); throw error }
}

/** Graceful manager shutdown interrupts without silently reusing an old runtime. */
export async function interruptPreview(database: typeof db, claim: PreviewClaim): Promise<void> {
  try {
    await database.transaction(async transaction => {
      await ownedClaim(transaction, claim)
      await transaction.update(previews).set({ status: 'interrupted',
        error: 'Preview management stopped. Restart the preview explicitly.', leaseExpiresAt: null, updatedAt: new Date() })
        .where(eq(previews.id, claim.previewId))
    })
  } catch (error) { logFailure(error, 'interruptPreview'); throw error }
}

/** Failure is independent of build success and retains resources until verified cleanup. */
export async function failPreview(database: typeof db, claim: PreviewClaim, message: string): Promise<void> {
  try {
    await database.transaction(async transaction => {
      await ownedClaim(transaction, claim)
      await transaction.update(previews).set({ status: 'failed', error: message.slice(0, MAX_ERROR_CHARS),
        leaseExpiresAt: null, updatedAt: new Date() }).where(eq(previews.id, claim.previewId))
    })
  } catch (error) { logFailure(error, 'failPreview'); throw error }
}

/** Revokes ready state immediately; does not release a claimed workspace/container reservation. */
export async function stopPreview(database: typeof db, previewId: string, userId: string): Promise<boolean> {
  try {
    return await database.transaction(async transaction => {
      const [row] = await transaction.select().from(previews)
        .where(eq(previews.id, previewId)).for('update')
      if (!row) return false
      const permission = await readProjectCapabilities(transaction, row.projectId, userId)
      if (!permission?.contribute) return false
      if (TERMINAL_STATES.some(status => status === row.status)) return true
      await transaction.update(previews).set({ status: 'stopped', updatedAt: new Date(),
        cleanupCompletedAt: row.status === 'queued' ? new Date() : null }).where(eq(previews.id, row.id))
      return true
    })
  } catch (error) { logFailure(error, 'stopPreview'); throw error }
}

/** Gateway calls only after successful viewer authorization; status polling must never call this. */
export async function touchPreviewViewer(database: typeof db, previewId: string, userId: string): Promise<boolean> {
  try {
    return await database.transaction(async transaction => {
      const [row] = await transaction.select().from(previews).where(eq(previews.id, previewId)).for('update')
      const now = new Date()
      if (!row || !await readProjectCapabilities(transaction, row.projectId, userId)) return false
      if (row.status !== 'ready' || !row.expiresAt || row.expiresAt <= now || !row.leaseExpiresAt || row.leaseExpiresAt <= now) return false
      // Coalesce activity writes; a polling observer is not viewer activity.
      if (!row.lastViewedAt || now.getTime() - row.lastViewedAt.getTime() >= PREVIEW_LEASE_MS)
        await transaction.update(previews).set({ lastViewedAt: now, expiresAt: new Date(now.getTime() + INACTIVITY_MS) }).where(eq(previews.id, row.id))
      return true
    })
  } catch (error) { logFailure(error, 'touchPreviewViewer'); throw error }
}

/** Revokes stale/expired state first; cleanup failures retain the reservation and original claim. */
export async function reconcilePreview(database: typeof db,
  cleanup: (claim: PreviewClaim, resources: PreviewResources | null) => Promise<void>, previewId?: string): Promise<boolean> {
  try {
    // Commit revocation before a potentially failing cleanup callback.
    const id = await database.transaction(async transaction => {
      const now = new Date()
      const candidates = await transaction.select().from(previews).where(and(
        previewId ? eq(previews.id, previewId) : undefined, isNull(previews.cleanupCompletedAt), or(
        inArray(previews.status, [...TERMINAL_STATES]),
        and(inArray(previews.status, [...LIVE_STATES]), lte(previews.leaseExpiresAt, now)),
        and(eq(previews.status, 'ready'), lte(previews.expiresAt, now)),
      ))).orderBy(asc(previews.createdAt)).limit(PREVIEW_CAPACITY).for('update', { skipLocked: true })
      // Database previews require independent app/socket/session/artifact receipts before capacity release.
      const row = candidates.find(candidate => !candidate.files.some(file => file.path === 'wrenly.app.json'))
      if (!row) return null
      if (LIVE_STATES.some(status => status === row.status))
        await transaction.update(previews).set({ status: row.status === 'ready' && row.expiresAt && row.expiresAt <= now ? 'expired' : 'interrupted',
          leaseExpiresAt: null, updatedAt: now }).where(eq(previews.id, row.id))
      return row.id
    })
    if (!id) return false
    return await database.transaction(async transaction => {
      const [row] = await transaction.select().from(previews).where(eq(previews.id, id)).for('update')
      if (!row || row.cleanupCompletedAt || row.files.some(file => file.path === 'wrenly.app.json')) return false
      if (!TERMINAL_STATES.some(status => status === row.status)) throw new PreviewClaimLostError()
      if (row.claimToken) await cleanup(claimOf(row), row.resources)
      await transaction.update(previews).set({ cleanupCompletedAt: new Date(), leaseExpiresAt: null, updatedAt: new Date() }).where(eq(previews.id, row.id))
      return true
    })
  } catch (error) { logFailure(error, 'reconcilePreview'); throw error }
}

/** Public state deliberately excludes source, Docker addresses, resources and claim secrets. */
export async function getOwnedPreview(database: typeof db, previewId: string, userId: string): Promise<PreviewSnapshot | null> {
  try {
    const [row] = await database.select().from(previews).where(eq(previews.id, previewId))
    if (!row || !await readProjectCapabilities(database,row.projectId,userId)) return null
    // Expired management claims must not appear live while reconciliation is blocked.
    const stale = LIVE_STATES.some(status => status === row.status) && (!row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= Date.now() ||
      (row.status === 'ready' && (!row.expiresAt || row.expiresAt.getTime() <= Date.now())))
    return { id: row.id, buildId: row.buildId, projectId: row.projectId, status: stale ? (row.expiresAt && row.expiresAt.getTime() <= Date.now() ? 'expired' : 'interrupted') : row.status,
      log: row.log, error: row.error, expiresAt: row.expiresAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
      cleanupPending: !row.cleanupCompletedAt && (stale || TERMINAL_STATES.some(status => status === row.status)) }
  } catch (error) { logFailure(error, 'getOwnedPreview'); throw error }
}

/** Finds a recovery candidate without locking it, so the worker can quiesce its executor before cleanup locks. */
export async function getPreviewRecoveryCandidate(database: typeof db): Promise<PreviewClaim | null> {
  try {
    const now = new Date()
    const candidates = await database.select().from(previews).where(and(isNull(previews.cleanupCompletedAt), or(
      inArray(previews.status, [...TERMINAL_STATES]),
      and(inArray(previews.status, [...LIVE_STATES]), lte(previews.leaseExpiresAt, now)),
      and(eq(previews.status, 'ready'), lte(previews.expiresAt, now)),
    ))).orderBy(asc(previews.createdAt)).limit(PREVIEW_CAPACITY)
    const row = candidates.find(candidate => !candidate.files.some(file => file.path === 'wrenly.app.json'))
    return row ? claimOf(row) : null
  } catch (error) { logFailure(error, 'getPreviewRecoveryCandidate'); throw error }
}

/** Fences each external resource creation without extending inactivity or execution ownership. */
export async function assertPreviewClaim(database: typeof db, claim: PreviewClaim): Promise<void> {
  try { await database.transaction(async transaction => { await ownedClaim(transaction, claim) }) }
  catch (error) { logFailure(error, 'assertPreviewClaim'); throw error }
}
