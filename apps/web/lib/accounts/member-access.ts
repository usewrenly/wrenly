// Validates directory metadata before member-management controls use it.
export interface ManagedMember {
  id: string;
  userId?: string;
  name: string;
  email: string;
  role: string;
  isOwner?: boolean;
  suspended?: boolean;
  accessRevision?: string;
  pictureUrl?: string | null;
}

export interface InstanceInvitation { id: string; email: string; status: string; expiresAt: string }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/** Projects directory data without inventing missing action authority or access status. */
export function parseAccountAccess(value: unknown): { members: ManagedMember[]; invitations: InstanceInvitation[] } {
  if (!record(value) || !Array.isArray(value.members) || !Array.isArray(value.invitations))
    throw new Error('Instance access could not be read.')
  const members = value.members.map((item: unknown): ManagedMember => {
    if (!record(item) || typeof item.id !== 'string' || typeof item.email !== 'string'
      || typeof item.name !== 'string' || typeof item.role !== 'string'
      || (item.userId !== undefined && typeof item.userId !== 'string')
      || (item.accessRevision !== undefined && typeof item.accessRevision !== 'string')
      || (item.suspended !== undefined && typeof item.suspended !== 'boolean')
      || (item.isOwner !== undefined && typeof item.isOwner !== 'boolean')
      || (item.pictureUrl !== undefined && item.pictureUrl !== null && typeof item.pictureUrl !== 'string')
      || (item.role === 'owner' && item.isOwner === false))
      throw new Error('Member access metadata could not be read.')
    return { id: item.id, name: item.name, email: item.email, role: item.role,
      userId: item.userId as string | undefined, accessRevision: item.accessRevision as string | undefined,
      suspended: item.suspended as boolean | undefined, isOwner: item.isOwner as boolean | undefined,
      pictureUrl: item.pictureUrl as string | null | undefined }
  })
  const invitations = value.invitations.map((item: unknown): InstanceInvitation => {
    if (!record(item) || typeof item.id !== 'string' || typeof item.email !== 'string'
      || typeof item.status !== 'string' || typeof item.expiresAt !== 'string')
      throw new Error('Invitation metadata could not be read.')
    return { id: item.id, email: item.email, status: item.status, expiresAt: item.expiresAt }
  })
  return { members, invitations }
}
