// Server-only deployment source snapshots, encrypted credentials and durable effect tracking.
// Handlers must select safe public fields explicitly instead of spreading these records.
import { pgEnum, pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index, integer, bigint } from 'drizzle-orm/pg-core'
import { projects, stackEnum } from '../projects/projects'
import { builds } from '../execution/builds'
import { user } from '../identity/auth'

export interface DeploymentSecretEnvelope {
  version: 1
  nonce: string
  tag: string
  ciphertext: string
}

export const deploymentStatusEnum = pgEnum('deployment_status', [
  'queued', 'preparing', 'deploying', 'verifying', 'success', 'failed', 'interrupted', 'cancelled',
])

export const deploymentQueue = pgTable('deployment_queue', { id: integer('id').primaryKey() })

export interface DeploymentMutationIntent {
  kind: 'create_repository' | 'register_git_key' | 'register_coolify_key' | 'push_source' | 'create_application' | 'set_environment' | 'trigger_deploy' | 'build_artifact' | 'push_artifact' | 'update_application'
  operationId: string
}

export const deploymentResources = pgTable('deployment_resources', {
  projectId: uuid('project_id').primaryKey().references(() => projects.id, { onDelete: 'restrict' }),
  // Store identity alongside credentials so config changes cannot silently reuse a foreign target.
  gitInstanceUrl: text('git_instance_url').notNull(),
  repositoryOwner: text('repository_owner').notNull(),
  repositoryName: text('repository_name').notNull(),
  repositoryId: text('repository_id'),
  gitDeployKeyId: text('git_deploy_key_id'),
  encryptedDeployPrivateKey: jsonb('encrypted_deploy_private_key').$type<DeploymentSecretEnvelope>(),
  coolifyInstanceUrl: text('coolify_instance_url').notNull(),
  coolifyProjectUuid: text('coolify_project_uuid').notNull(),
  coolifyServerUuid: text('coolify_server_uuid').notNull(),
  coolifyEnvironmentName: text('coolify_environment_name').notNull(),
  registryOrigin: text('registry_origin'),
  registryNamespace: text('registry_namespace'),
  coolifyPrivateKeyUuid: text('coolify_private_key_uuid'),
  coolifyApplicationUuid: text('coolify_application_uuid'),
  encryptedLaravelAppKey: jsonb('encrypted_laravel_app_key').$type<DeploymentSecretEnvelope>(),
  encryptedRuntimeEnvironment: jsonb('encrypted_runtime_environment').$type<DeploymentSecretEnvelope>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const deployments = pgTable('deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => deploymentResources.projectId, { onDelete: 'restrict' }),
  buildId: uuid('build_id').notNull().references(() => builds.id, { onDelete: 'restrict' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  idempotencyKey: uuid('idempotency_key').notNull(),
  requestIdentity: text('request_identity').notNull(),
  stack: stackEnum('stack').notNull(),
  files: jsonb('files').$type<Array<{ path: string; content: string }>>().notNull(),
  sourceSha256: text('source_sha256').notNull(),
  status: deploymentStatusEnum('status').notNull().default('queued'),
  claimToken: uuid('claim_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
  gitCommitSha: text('git_commit_sha'),
  artifactImageId: text('artifact_image_id'),
  artifactBaseImageId: text('artifact_base_image_id'),
  artifactSizeBytes: bigint('artifact_size_bytes', { mode: 'number' }),
  registryRepository: text('registry_repository'),
  registryDigest: text('registry_digest'),
  remoteDeploymentUuid: text('remote_deployment_uuid'),
  mutationIntent: jsonb('mutation_intent').$type<DeploymentMutationIntent>(),
  url: text('url'),
  errorCode: text('error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, table => [
  uniqueIndex('deployments_user_idempotency_unique').on(table.userId, table.idempotencyKey),
  index('deployments_project_created_index').on(table.projectId, table.createdAt),
])
