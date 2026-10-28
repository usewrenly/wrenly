/**
 * Uses Better Auth's real password format for isolated database/API acceptance.
 * Better Auth is an API dependency; database fixtures import this helper rather
 * than adding authentication implementation dependencies to the database library.
 */
export { hashPassword as hashFixturePassword } from 'better-auth/crypto'
