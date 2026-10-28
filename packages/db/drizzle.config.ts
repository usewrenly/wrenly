// Migration tooling loads root configuration; explicit shell variables take precedence.
import { config } from 'dotenv'
import { resolve } from 'path'
import type { Config } from 'drizzle-kit'

import { readControlDatabaseUrl } from './src/connections/database-url'

config({ path: resolve(__dirname, '../../.env'), quiet: true })
const url = readControlDatabaseUrl()

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
} satisfies Config
