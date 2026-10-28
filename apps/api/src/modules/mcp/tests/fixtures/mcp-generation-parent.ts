// Controlled crash fixture; no model provider is contacted.
import { join } from 'path'
import { generateWithMcp } from '../../mcp-generation'

const pidFile = process.argv[2]
if (!pidFile) throw new Error('Missing child PID file')
await generateWithMcp({
  command: process.execPath,
  args: [join(import.meta.dir, 'mcp-generation-server.ts'), pidFile, 'tool-hang'], env: {},
}, { prompt: 'Controlled crash test', attempt: 1, previousErrors: [] })
