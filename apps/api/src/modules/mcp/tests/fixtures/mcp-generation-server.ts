// Controlled test server: never calls inference or executes generated application code.
import { writeFileSync } from 'fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const pidFile = process.argv[2]
const mode = process.argv[3]
if (!pidFile) throw new Error('Missing test PID file')
writeFileSync(pidFile, String(process.pid))
process.stdin.on('end', () => process.exit(0))
if (mode === 'initialize-hang') {
  process.stdin.resume()
  setInterval(() => {}, 1000)
} else {
  const server = new Server({ name: 'wrenly-test', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'generate_app', inputSchema: { type: 'object' } }] }))
  server.setRequestHandler(CallToolRequestSchema, async () => {
    if (mode === 'tool-hang') await new Promise<never>(() => {})
    return { content: [{ type: 'text', text: JSON.stringify({ files: [{ path: 'package.json', content: '{}' }] }) }] }
  })
  await server.connect(new StdioServerTransport())
}
